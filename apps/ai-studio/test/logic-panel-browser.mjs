import { LogicExplorerPanel } from '@haiyue/ai-studio-shell';
import fixture from './logic-fixture.generated.json';
const get = id => document.getElementById(id), intents = [];
const panel = new LogicExplorerPanel(document, get('host'), intent => intents.push(intent));
const base = { documentId: fixture.manifest.binding.documentId, documentRevision: fixture.manifest.binding.documentRevision, entityId: 'entity:main', state: 'ready', diagnostic: null, manifest: fixture.manifest, explanation: fixture.explanation, trace: fixture.trace, traceStatus: 'current', artifacts: [], playing: true };
const assert = (value, message) => { if (!value) throw Error(message); };
panel.update(base);
window.logicTest = { panel, base, get, intents, assert, fixture };
document.body.dataset.ready = 'true';
