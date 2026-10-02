import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

const browser = await chromium.launch({ headless: false });

try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });

  console.log('title:    ', await page.title());
  console.log('final URL:', page.url());
  console.log(
    'canonical:',
    await page.locator('link[rel="canonical"]').getAttribute('href').catch(() => null)
  );

  const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  console.log(`\nJSON-LD blocks: ${jsonLd.length}`);
  jsonLd.forEach((text, i) => console.log(`--- #${i}\n${text.trim()}`));

  // усі hidden-поля: звідси шукаємо ID товару
  const hidden = await page.$$eval('input[type="hidden"]', (inputs) =>
    inputs.map((el) => ({ name: el.name, value: el.value }))
  );
  console.log(`\nhidden inputs: ${hidden.length}`);
  console.table(hidden.filter((h) => /id|sku|product/i.test(h.name)));

  await mkdir('output', { recursive: true });
  await writeFile('output/page.html', await page.content());
  console.log('\nsaved output/page.html');
} finally {
  await browser.close();
}
