// Spring sampler imported from santi.harbor/src/lq.js. Same presets, 1/480s
// integrator and 49-stop compositor curves; isolated from Harbor's VPN UI.
const presets = {snappy:[.26,.72],bouncy:[.3,1],push:[.32,.94],gentle:[.5,1],wobbly:[.38,.28],release:[.42,.58]} as const;
const durations = {snappy:100,bouncy:180,push:160,gentle:150,wobbly:300,release:260};
const timeScales = new Map<string,number>();
const curves = new Map<string,{easing:string;duration:number}>();
export function harborCurve(name:keyof typeof presets) {
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return {easing:'linear',duration:1};
  if(curves.has(name))return curves.get(name)!;
  const [response,damping]=presets[name],k=(2*Math.PI/response)**2,c=4*Math.PI*damping/response,h=1/480;
  let x=0,v=0,time=0;const samples=[0];
  while(time<3&&!(Math.abs(1-x)<1e-3&&Math.abs(v)<1e-2)) {v+=(k*(1-x)-c*v)*h;x+=v*h;time+=h;samples.push(x);}
  samples[samples.length-1]=1;
  const stops=Array.from({length:49},(_,i)=>samples[Math.round(i/48*(samples.length-1))].toFixed(4));
  const curve={easing:CSS.supports('animation-timing-function','linear(0, 1)')?`linear(${stops.join(', ')})`:'cubic-bezier(.2,.8,.2,1)',duration:durations[name]};
  timeScales.set(name,time*1000/durations[name]);
  curves.set(name,curve);return curve;
}
export function harborTimeScale(name:keyof typeof presets){harborCurve(name);return timeScales.get(name)||1;}
export function installHarborMotion() {
  const sync=()=>{for(const name of Object.keys(presets) as (keyof typeof presets)[]) {
      const curve=harborCurve(name);
      document.documentElement.style.setProperty(`--sp-${name}`,curve.easing);
      document.documentElement.style.setProperty(`--sp-${name}-ms`,`${curve.duration}ms`);
  }};
  sync();matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',sync);
}
