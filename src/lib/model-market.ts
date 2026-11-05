import { adminApiUrl, serviceDisplayText } from "@/lib/admin-backend";

export interface ModelMarketItem {
  id: string | number;
  modelName: string;
  storeName: string;
  price: number;
  link: string;
  imageUrl: string;
  description: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeLink(value: unknown): string {
  const candidate = text(value);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeImage(value: unknown): string {
  const candidate = text(value);
  if (/^\/api\/client\/model-market\/images\/[a-f0-9]{32}\.(?:png|jpg|webp|gif)$/i.test(candidate)) {
    return adminApiUrl(candidate);
  }
  if (candidate.length <= 3_000_000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(candidate)) return candidate;
  return safeLink(candidate);
}

function normalizeItem(raw: Record<string, unknown>, index: number): ModelMarketItem | null {
  const modelName = text(raw.modelName ?? raw.model_name ?? raw.name);
  const storeName = text(raw.storeName ?? raw.store_name ?? raw.shopName ?? raw.shop_name);
  const link = safeLink(raw.linkUrl ?? raw.link ?? raw.url ?? raw.purchaseUrl ?? raw.purchase_url);
  const imageUrl = safeImage(raw.imageUrl ?? raw.image_url ?? raw.image);
  const price = Number(raw.price);
  if (!modelName || !Number.isFinite(price) || price < 0) return null;
  return {
    id: raw.id as string | number ?? index,
    modelName,
    storeName,
    price,
    link,
    imageUrl,
    description: text(raw.description ?? raw.notes),
  };
}

export async function fetchModelMarket(): Promise<ModelMarketItem[]> {
  const response = await fetch(adminApiUrl("/client/model-market"), { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(serviceDisplayText(payload.error || `读取模型广场失败 (${response.status})`));
  }
  const rawItems = Array.isArray(payload.data) ? payload.data : payload.data?.items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map(normalizeItem)
    .filter((item): item is ModelMarketItem => Boolean(item));
}
