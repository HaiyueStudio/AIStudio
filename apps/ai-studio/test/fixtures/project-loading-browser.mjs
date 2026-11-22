import{ProjectLoading}from'../../dist/project-loading.js';
const loading=new ProjectLoading(document);let release,reject,pending,calls=0,painted=false,error=null;
const run=()=>{pending=loading.run(async()=>{calls++;painted=!document.querySelector('#project-loading').hidden&&getComputedStyle(document.querySelector('#project-loading')).display==='grid';await new Promise((resolve,fail)=>{release=resolve;reject=fail;});},'正在加载工程…');pending.catch(cause=>error=cause.message);return pending;};
document.querySelector('#open-project').addEventListener('click',run);
window.fixture={run,duplicate(){return loading.run(async()=>{calls++;},'duplicate')===pending;},get calls(){return calls;},get painted(){return painted;},get busy(){return loading.busy;},get error(){return error;},resolve(){release();},reject(message){reject(Error(message));},dispose(){loading.dispose();},async settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}};
document.body.dataset.ready='true';
