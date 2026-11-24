import {
  createEgressGateway,
  withCredentialFetch,
  type CredentialBoundaryRef,
  type EgressPolicy,
} from "@zeta-agent/security";

export interface ImageSource {
  readonly data?: string;
  readonly url?: string;
  readonly mimeType: string;
}

export interface EncodedImage {
  readonly dataUrl: string;
  readonly mimeType: string;
}

/** 将图片源编码为 data URL（或保留外部 URL），不触碰外部系统。 */
export function encodeImage(source: ImageSource): EncodedImage {
  if (typeof source.data === "string" && source.data.length > 0) {
    return {
      dataUrl: `data:${source.mimeType};base64,${source.data}`,
      mimeType: source.mimeType,
    };
  }
  if (typeof source.url === "string" && source.url.length > 0) {
    return { dataUrl: source.url, mimeType: source.mimeType };
  }
  throw new Error("IMAGE_SOURCE_REQUIRED: 图片须提供 data(base64) 或 url");
}

export interface FetchImageOptions {
  /** 远程图片抓取同样走统一凭证边界，明文不进入调用方配置。 */
  readonly credentialBoundary?: CredentialBoundaryRef;
  /** 数据面 egress 策略：缺省不额外约束（沿用注入 fetch 的治理）。 */
  readonly egress?: { readonly policy: EgressPolicy };
}

/** 远程图片字节抓取：凭据只在 fetch 边界注入，绑定/TTL/revision 失败在请求前抛错。 */
export async function fetchImageBytes(
  source: ImageSource,
  options: FetchImageOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<Uint8Array> {
  if (typeof source.url !== "string" || source.url.length === 0) {
    throw new Error("IMAGE_SOURCE_REQUIRED: 远程抓取须提供 url");
  }
  const boundary = options.credentialBoundary;
  let gated: typeof fetch = boundary === undefined
    ? fetchImpl
    : withCredentialFetch(boundary.broker, boundary.handle, fetchImpl);
  if (options.egress !== undefined) {
    const gateway = createEgressGateway({ policy: options.egress.policy, fetch: gated });
    gated = gateway.fetch as typeof fetch;
  }
  const response = await gated(source.url, { method: "GET" });
  if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export interface ImageContentPart {
  readonly type: "text" | "image_url";
  readonly text?: string;
  readonly image_url?: { readonly url: string };
}

/** 构造一条含文字与图片的多模态 user 消息。 */
export function imageMessage(
  text: string,
  source: ImageSource
): { readonly role: "user"; readonly content: readonly ImageContentPart[] } {
  const encoded = encodeImage(source);
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: encoded.dataUrl } },
    ],
  };
}
