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
  return { image_url: main, additional_image_urls: [...additional] };
};
