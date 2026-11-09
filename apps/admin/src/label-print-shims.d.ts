declare module 'bwip-js' {
  const bwipjs: {
    toBuffer(options: { bcid: string; text: string; scale: number; height: number; includetext: boolean }): Promise<Uint8Array>;
  };
  export default bwipjs;
}
