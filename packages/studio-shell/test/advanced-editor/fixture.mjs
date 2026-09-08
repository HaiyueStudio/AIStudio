import { EditorSelectionService } from '@haiyue/editor-platform';
import { UnifiedSceneSelectionService } from '@haiyue/ai-studio-editor-plugins';
import { behaviorFixture, execute } from '../../../game-authoring-tools/test/behavior-fixture.mjs';
import { adaptAdvancedStudioIntent, isAdvancedStudioCurrent, projectAdvancedStudio } from '../../dist/panels/advanced/index.js';

export async function fixture() {
  const f = await behaviorFixture({noSource:true}), selection = new EditorSelectionService(), unified = new UnifiedSceneSelectionService(selection,f.scene,f.operationLog);
  unified.select(f.entityId,'hierarchy');
  let epoch = 'open:fixture-1';
  const source = () => ({epoch,document:f.workspace.gameSnapshot(),definitions:f.workspace.componentRegistry.snapshot().definitions,selection:selection.snapshot(),history:f.workspace.snapshot().history,projection:{origin:[200,180],axes:{x:[70,0],y:[0,-70],z:[-45,35]},unitsPerPixel:.1},playId:null,observation:null,observationValue:null,observationEpoch:null,observationDocumentId:null});
  const dispatch = async (intent,signal = new AbortController().signal, approve = true) => {
    if (signal.aborted || 'stamp' in intent && !isAdvancedStudioCurrent(source(),intent.stamp)) throw Error('stale owner');
    if (intent.type === 'author') return execute(f,intent.toolId,intent.arguments,approve);
    if (intent.type === 'select') return unified.select(intent.reference?.id ?? null,'inspector');
    if (intent.type === 'undo' || intent.type === 'redo') return f.workspace[intent.type](intent.stamp.baseRevision);
  };
  const view = () => projectAdvancedStudio(source());
  const emit = (type,args={}) => adaptAdvancedStudioIntent({type,binding:view().binding,...args},source());
  return {...f,selection,unified,source,view,emit,dispatch,setEpoch:value=>epoch=value,close:async()=>{await unified.whenIdle();selection.dispose();await f.close();}};
}
