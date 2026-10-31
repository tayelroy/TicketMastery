// qrcode's encoder core only: the package entry point also pulls in the PNG/SVG/terminal renderers, which the
// PDF doesn't need (it draws the modules itself). @types/qrcode doesn't describe this file.
declare module 'qrcode/lib/core/qrcode.js' {
  interface QrSymbol {
    modules: { size: number; get(row: number, col: number): number };
  }
  const qrcode: {
    create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): QrSymbol;
  };
  export default qrcode;
}
