import { ResourceExplorerPanel } from '@haiyue/ai-studio-shell/resources';
import { ResourceThumbnails } from '../../src/resource-thumbnails.ts';
import { defineTabsComponents } from '@haiyue/ui/tabs';
defineTabsComponents();
window.addEventListener('unhandledrejection', event => console.error(String(event.reason?.stack ?? event.reason)));
const bridge = window.resourceBridge;
const thumbnails = new ResourceThumbnails(document, (id) => bridge.read(id));
let data, pending = Promise.resolve();
const panel = new ResourceExplorerPanel(document, document.querySelector('main'), intent => {
  if (intent.type === 'query' || intent.type === 'refresh') return pending = bridge.query(intent.query).then(update);
}, (canvas, item, signal) => thumbnails.render(canvas, item, signal));
function update(next) { data = next; thumbnails.setProject(data.projectKey); panel.update(data); }
function assert(value, reason) { if (!value) throw Error(reason); }
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function ready() {
  await pending;
  for (let i=0;i<300;i++) {
    if (panel.root.getAttribute('aria-busy') === 'false' && [...panel.root.querySelectorAll('canvas')].every(c=>c.dataset.thumbnailReady==='true')) return;
    await frame();
  }
  throw Error('Thumbnail render deadline');
}
async function category(value) {
  const tabs = panel.root.querySelector('hy-tabs'); tabs.value=value; tabs.dispatchEvent(new CustomEvent('tab-change',{detail:{value}}));
  await Promise.resolve(); await ready();
}
await bridge.query({category:'Geometry',limit:25}).then(update);
await ready();
assert(data.total === 2, 'Only the two project geometries are listed');
assert(panel.root.querySelector('[data-resource=detail]').hidden, 'Details start hidden');
const canvases = [...panel.root.querySelectorAll('canvas')];
const png = canvas=>canvas.toDataURL();
assert(png(canvases[0])!==png(canvases[1]), 'Rounded box and sphere have different engine meshes');
assert(canvases.every(c=>c.getContext('2d').getImageData(0,0,128,128).data.some((v,i)=>i%4===3 && v>0)), 'Wireframes contain pixels');
const button = panel.root.querySelector('[data-resource-entry]');
assert(button.children.length===2 && button.children[0].tagName==='CANVAS', 'Each card shows only thumbnail and name');
button.click(); assert(!panel.root.querySelector('[data-resource=detail]').hidden,'Click opens details');
panel.root.querySelector('[data-resource=detail] button').click(); assert(panel.root.querySelector('[data-resource=detail]').hidden,'Close returns to compact inventory');
await category('Material'); assert(data.total===2,'Actual materials only');
const materials=[...panel.root.querySelectorAll('canvas')];
assert(png(materials[0])!==png(materials[1]),'Material spheres reflect different project colors');
await category('Texture'); assert(data.total===1,'Environment aspect ratio does not hide texture');
const texture=panel.root.querySelector('canvas'), pixels=texture.getContext('2d').getImageData(0,0,128,128).data;
assert(pixels[3]===0 && pixels[(64*128+64)*4+3]===255,'Texture preserves 2:1 aspect ratio');
assert(pixels[(64*128+64)*4+2]>180,'Real controlled PNG pixels are decoded');
const before=png(texture); await category('Geometry'); await category('Texture');
assert(png(panel.root.querySelector('canvas'))===before,'Cached texture survives tab switches');
window.thumbnailTest={panel, thumbnails, ready, category, done:true, checks:['project-only','geometry-meshes','material-colors','texture-pixels','aspect-ratio','compact-cards','detail-open-close','cache']};
