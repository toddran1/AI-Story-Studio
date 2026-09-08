import { TTSRequest, TTSResult } from "./types.js";
export interface TTSProvider { readonly name: "fish"; synthesize(request: TTSRequest): Promise<TTSResult>; validateConfiguration(): Promise<void>; }
