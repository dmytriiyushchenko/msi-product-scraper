import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const PRODUCT_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_DIR = 'output';
const OUTPUT_FILE = `${OUTPUT_DIR}/product.json`;

// ---------- helpers ----------

// Стискає будь-які пробіли/переноси в один пробіл. Порожній результат -> null.
const cleanText = (text) => {
  if (text == null) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
};

// "$1,259.99" -> 1259.99. Якщо числа немає -> null.
const parsePrice = (text) => {
  const match = cleanText(text)?.match(/\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
};

// Текст зі сторінки -> один із чотирьох дозволених статусів.
const normalizeAvailability = (text) => {
  const lower = cleanText(text)?.toLowerCase() ?? '';
  if (lower.includes('out of stock') || lower.includes('sold out')) return 'out_of_stock';
  if (/pre-?\s?order/.test(lower)) return 'pre_order';
  if (lower.includes('in stock')) return 'in_stock';
  return null;
};

// Відносний або абсолютний href -> повний URL. Немає href -> null.
const toAbsoluteUrl = (href, baseUrl) => {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
};

// "Home" і поточний товар (останній, active) у категорії не входять.
const extractBreadcrumbs = (items, baseUrl) =>
  items
    .filter((item) => !item.isCurrent && cleanText(item.text)?.toLowerCase() !== 'home')
    .map((item) => ({
      name: cleanText(item.text),
      url: toAbsoluteUrl(item.href, baseUrl),
    }));

// Один і той самий файл є в різних розмірах (-400x400, -1024x1024).
// Приводимо до найбільшого розміру, щоб Set прибрав дублікати.
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
  // Карусель перемішує слайди в DOM, тому сортуємо за номером у назві файлу.
  const sorted = [...additional].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { image_url: main, additional_image_urls: sorted };
};

// Сирі рядки таблиці -> [{ name, value }]. Рядки без назви пропускаємо.
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

// Бренд — це те, що стоїть у <title> перед назвою товару ("MSI MAG Z890..." -> "MSI").
const extractBrand = (pageTitle, productTitle) => {
  if (!pageTitle || !productTitle || !pageTitle.includes(productTitle)) return null;
  return cleanText(pageTitle.split(productTitle)[0]);
};

const findSpecValue = (specs, namePattern) =>
  specs.find((spec) => namePattern.test(spec.name))?.value ?? null;

// Текст першого елемента за селектором, або null, якщо елемента немає.
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

  // Ціна — тільки з #prices-wrapper, щоб не зачепити блок "Recommended for you".
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
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#prices-new');

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
