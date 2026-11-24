import { ModSandbox } from '../src/sandbox.js';
const s = new ModSandbox('m1', { here:[0,0,-6], author:{id:'p1',name:'john'} });
console.log(s.load(`const b = world.spawn({name:'box', position: here}); world.setGravity(1.62); world.onTick((dt,t)=>{ world.move(b,[0,Math.sin(t),0]) }); items.register({name:'ball',icon:'⚽',onUse(p){ players.message(p.id,'hi '+p.name) }})`));
console.log(s.call('h1',[0.05,1.0],[]));
console.log(s.call('h2',[{id:'p1',name:'john'}],[]));
const bad = new ModSandbox('m2', { here:[0,0,0], author:{} });
let t=Date.now(); try { bad.load('while(true){}') } catch(e){ console.log('loop caught:', e.message, Date.now()-t,'ms') }
try { new ModSandbox('m3',{here:[0,0,0],author:{}}).load('const a=[];while(true)a.push("x".repeat(1e5))') } catch(e){ console.log('mem caught:', e.message) }
try { new ModSandbox('m4',{here:[0,0,0],author:{}}).load('process.exit(1)') } catch(e){ console.log('no process:', e.message) }
