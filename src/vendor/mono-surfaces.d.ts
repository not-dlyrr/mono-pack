export {};
declare global {
  interface Window {
    MonoSurfaces: {
      install:()=>()=>void;
      watchSurface:(element:HTMLElement,listener?:(behind:boolean)=>void)=>()=>void;
      refresh:()=>void;
    };
  }
}
