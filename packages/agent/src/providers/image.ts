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
