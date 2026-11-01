/**
 * Ambient declarations for dependencies without bundled types.
 * transcribe-cpp and node-llama-cpp ship their own declarations.
 */

declare module "opencc-js" {
  interface ConverterOptions {
    from: string;
    to: string;
  }
  const OpenCC: {
    Converter(options: ConverterOptions): (text: string) => string;
  };
  export default OpenCC;
}
