export type ImageGenerationRequest = { model: string; prompt: string; quality: "low" | "medium" | "high"; size: "1536x1024" | "1024x1024" | "1024x1536"; outputFormat: "png" };
export type ImageGenerationResult = { data: Buffer; mimeType: "image/png"; revisedPrompt?: string; requestId?: string };
export interface ImageProvider { readonly name: string; readonly version: string; validateConfiguration(): Promise<void>; generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>; }
