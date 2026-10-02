import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const PRODUCT_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_DIR = 'output';
const OUTPUT_FILE = `${OUTPUT_DIR}/product.json`;

// ---------- helpers ----------

// Collapses any whitespace/newlines into single spaces. Empty result -> null.
const cleanText = (text) => {
  if (text == null) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
};

// "$1,259.99" -> 1259.99. No number found -> null.
const parsePrice = (text) => {
  const match = cleanText(text)?.match(/\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
};

// Page text -> one of the four allowed statuses.
const normalizeAvailability = (text) => {
  const lower = cleanText(text)?.toLowerCase() ?? '';
  if (lower.includes('out of stock') || lower.includes('sold out')) return 'out_of_stock';
  if (/pre-?\s?order/.test(lower)) return 'pre_order';
  if (lower.includes('in stock')) return 'in_stock';
  return null;
};

// Relative or absolute href -> full URL. No href -> null.
const toAbsoluteUrl = (href, baseUrl) => {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
};

// "Home" and the current product (the last, active item) are not categories.
const extractBreadcrumbs = (items, baseUrl) =>
  items
    .filter((item) => !item.isCurrent && cleanText(item.text)?.toLowerCase() !== 'home')
    .map((item) => ({
      name: cleanText(item.text),
      url: toAbsoluteUrl(item.href, baseUrl),
    }));

// The same image shows up in different sizes (-400x400, -1024x1024).
// Switch everything to the big one so the Set can drop duplicates.
const toLargeImageUrl = (src) => src.replace(/-\d+x\d+(\.\w+)$/, '-1024x1024$1');

const extractImages = (mainSrc, gallerySrcs, baseUrl) => {
  const toUrl = (src) => toAbsoluteUrl(src, baseUrl);
  const main = mainSrc ? toLargeImageUrl(toUrl(mainSrc)) : null;
  const additional = new Set(
    gallerySrcs
      .map(toUrl)
      .filter(Boolean)
      .map(toLargeImageUrl)
  );
  additional.delete(main);
  // The carousel shuffles slides in the DOM, so sort by the number in the file name.
  const sorted = [...additional].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { image_url: main, additional_image_urls: sorted };
};

// Raw table rows -> [{ name, value }]. Rows without a name are skipped.
const extractSpecs = (rows) =>
  rows
    .map((row) => ({ name: cleanText(row.name), value: cleanText(row.value) }))
    .filter((spec) => spec.name !== null);

// "4.7 (3)" -> { star_rating: 4.7, review_count: 3 }
const parseRating = (text) => {
  const match = cleanText(text)?.match(/(\d+(?:\.\d+)?)\s*\((\d+)\)/);
  return match
    ? { star_rating: Number(match[1]), review_count: Number(match[2]) }
    : { star_rating: null, review_count: null };
};

// No brand element on the page, so take whatever comes before the product
// name in <title> ("MSI MAG Z890..." -> "MSI").
const extractBrand = (pageTitle, productTitle) => {
  if (!pageTitle || !productTitle || !pageTitle.includes(productTitle)) return null;
  return cleanText(pageTitle.split(productTitle)[0]);
};

const findSpecValue = (specs, namePattern) =>
  specs.find((spec) => namePattern.test(spec.name))?.value ?? null;

// Waits up to 5s for an optional element. Never throws.
const waitIfPresent = (page, selector) =>
  page.waitForSelector(selector, { state: 'attached', timeout: 5000 }).catch(() => null);

// Text of the first match, or null if there is no such element.
const textOf = async (page, selector) => {
  const locator = page.locator(selector).first();
  return (await locator.count()) ? cleanText(await locator.innerText()) : null;
};

// ---------- scraping ----------

const scrapeProduct = async (page) => {
  const url = page.url();

  const title = await textOf(page, '.product-detail h2.title');
  const brand = extractBrand(await page.title(), title);

  const itemId = await page
    .locator('#product_qty input[name="product_id"]')
    .first()
    .inputValue()
    .catch(() => null);

  const breadcrumbItems = await page
    .locator('ol.breadcrumb li.breadcrumb-item')
    .evaluateAll((items) =>
      items.map((li) => ({
        text: li.textContent,
        href: li.querySelector('a')?.getAttribute('href') ?? null,
        isCurrent: li.classList.contains('active'),
      }))
    );
  const category_tree = extractBreadcrumbs(breadcrumbItems, url);

  // Price only from #prices-wrapper, so we never pick up "Recommended for you".
  const currentPrice = parsePrice(await textOf(page, '#prices-new'));
  const oldPrice = parsePrice(await textOf(page, '#prices-wrapper .prices-old, #prices-wrapper .price-old'));
  const hasDiscount = oldPrice !== null && currentPrice !== null && oldPrice > currentPrice;

  const mainSrc = await page.locator('#imagePopup').first().getAttribute('src').catch(() => null);
  const gallerySrcs = await page
    .locator('#carouselImages img')
    .evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));

  const specRows = await page.locator('table.table-borderless tr').evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector('th')?.textContent ?? null,
      value: row.querySelector('td')?.textContent ?? null,
    }))
  );
  const specs = extractSpecs(specRows);

  return {
    url,
    item_id: cleanText(itemId),
    title,
    brand,
    product_category: category_tree.length
      ? category_tree.map((category) => category.name).join(' > ')
      : null,
    category_tree,
    description: await textOf(page, '#description-list'),
    price: hasDiscount ? oldPrice : currentPrice,
    sale_price: hasDiscount ? currentPrice : null,
    availability: normalizeAvailability(await textOf(page, '#prices-wrapper')),
    ...extractImages(mainSrc, gallerySrcs, url),
    specs,
    ...parseRating(await textOf(page, '#average-rating-info')),
    gtin: findSpecValue(specs, /gtin|upc|ean/i),
    mpn: findSpecValue(specs, /manufacturer number/i),
    scraped_at: new Date().toISOString(),
  };
};

const main = async () => {
  // The site (Akamai) returns 403 to headless browsers, so the window is
  // visible by default. Try HEADLESS=true npm run scrape to see for yourself.
  const browser = await chromium.launch({ headless: process.env.HEADLESS === 'true' });
  try {
    const page = await browser.newPage();
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#prices-new');
    // Rating and gallery are filled in by JS a bit later. They may legitimately
    // be missing, so wait a few seconds and move on if they never show up.
    await waitIfPresent(page, '#average-rating-info');
    await waitIfPresent(page, '#carouselImages img');

    const product = await scrapeProduct(page);

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(OUTPUT_FILE, JSON.stringify(product, null, 2));
    console.log(`Saved ${OUTPUT_FILE}`);
  } catch (error) {
    console.error('Scraping failed:', error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
};

await main();
