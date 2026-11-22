/** Renderer-owned feedback for one project transition, including its first painted frame. */
export class ProjectLoading {
  private readonly overlay: HTMLElement;
  private readonly label: HTMLElement;
  private readonly lifetime = new AbortController();
  private pending: Promise<void> | null = null;
  private previous: Array<{element:HTMLElement;inert:boolean;busy:string|null}> = [];
  private focus: HTMLElement | null = null;
  private disposed = false;
  constructor(private readonly document: Document) {
    this.overlay = document.createElement('section');
    this.overlay.id = 'project-loading'; this.overlay.hidden = true; this.overlay.tabIndex = -1;
    this.overlay.setAttribute('role','status'); this.overlay.setAttribute('aria-live','polite');
    const card=document.createElement('div');card.className='project-loading-card';
    const spinner=document.createElement('span');spinner.className='project-loading-spinner';spinner.setAttribute('aria-hidden','true');
    this.label=document.createElement('strong');this.label.id='project-loading-label';
    this.overlay.setAttribute('aria-labelledby',this.label.id);card.append(spinner,this.label);this.overlay.append(card);document.body.append(this.overlay);
    document.defaultView?.addEventListener('beforeunload',()=>this.dispose(),{signal:this.lifetime.signal});
  }
  get busy(): boolean { return this.pending !== null; }
  run(operation:()=>Promise<void>,label:string):Promise<void> {
    if(this.disposed)return Promise.reject(new Error('Project loading view is disposed.'));
    if(this.pending)return this.pending;
    this.focus=this.document.activeElement instanceof HTMLElement?this.document.activeElement:null;
    this.label.textContent=label;this.overlay.hidden=false;this.document.body.dataset.projectLoading='true';
    this.previous=[...this.document.querySelectorAll<HTMLElement>('#app,#play-page')].map(element=>({element,inert:element.inert,busy:element.getAttribute('aria-busy')}));
    for(const {element}of this.previous){element.inert=true;element.setAttribute('aria-busy','true');}
    this.overlay.focus();
    const task=(async()=>{try{
      await this.paint();if(this.disposed)return;
      await operation();
      if(!this.disposed)await this.paint();
    }finally{if(!this.disposed)this.hide();}})();
    this.pending=task;
    void task.then(()=>{this.pending=null;},()=>{this.pending=null;});
    return task;
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.hide();this.overlay.remove();}
  private paint():Promise<void>{const view=this.document.defaultView;return view?new Promise(resolve=>view.requestAnimationFrame(()=>view.requestAnimationFrame(()=>resolve()))):Promise.resolve();}
  private hide():void{
    this.overlay.hidden=true;delete this.document.body.dataset.projectLoading;
    for(const {element,inert,busy}of this.previous){element.inert=inert;if(busy===null)element.removeAttribute('aria-busy');else element.setAttribute('aria-busy',busy);}
    this.previous=[];if(this.focus?.isConnected)this.focus.focus();this.focus=null;
  }
}
