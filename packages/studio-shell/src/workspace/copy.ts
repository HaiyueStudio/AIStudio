export type WorkspaceLanguage = 'en' | 'zh-CN';
const zh = {
  logic: '逻辑', resources: '资源', workspace: '项目工作区', advanced: '高级编辑', close: '关闭', inspect: '层级与属性', script: '脚本',
  mode: '工作区布局', intent: '逻辑 / 资源布局', classic: '经典布局', search: '查找对象', entity: '选择对象', noEntities: '项目中还没有对象', noMatches: '没有匹配的对象',
  choose: '选择一个对象查看来源', events: '事件入口', pending: '行为分析尚未就绪。可先查看已有脚本与组件配置。', noEvents: '当前分析没有列出事件入口；这不代表对象没有行为。',
  stale: '此记录对应旧版本，已停止将它作为当前项目内容显示。', more: '内容已截断，完整结构需通过行为查询查看。',
  sources: '来源', 'source-script': '脚本', 'source-declarative-component': '组件配置', 'source-runtime-adapter': '运行适配器', unknown: '未知关系', established: '静态结构',
  category: '分类', kind: '种类', allKinds: '全部种类', all: '全部分类', scene: '场景', other: '其他', asset: '文件资产', template: '创建模板', preset: '预设', instance: '场景实例',
  geometry: '几何体', lights: '灯光', materials: '材质', textures: '纹理', models: '模型', scripts: '脚本',
  catalogPending: '项目资源目录尚未就绪。下方保留已有创建、分配与脚本入口。', emptyCatalog: '这个分类下还没有目录条目。', unavailable: '暂不可用', locate: '定位来源',
  dependenciesUnknown: '依赖尚未确认', usageUnknown: '使用情况尚未确认', unusedInapplicable: '不适用未使用资产筛选',
  sourceDetails: '来源位置', locationPending: '来源定位服务尚未就绪。', failed: '操作未完成，请重试。',
  'resource.locate': '定位来源', 'asset.assign': '分配资产', 'asset.inspect': '查看资产', 'template.create': '创建对象', 'preset.apply': '应用预设', 'instance.inspect': '查看实例',
  manualInspect: '查看层级与属性', manualScript: '打开脚本编辑', sourceHint: '此处显示来源位置，具体定位由项目服务校验版本。',
};
const en: Record<keyof typeof zh, string> = {
  logic:'Logic',resources:'Resources',workspace:'Project workspace',advanced:'Advanced',close:'Close',inspect:'Hierarchy & properties',script:'Script',
  mode:'Workspace layout',intent:'Logic / Resources',classic:'Classic layout',search:'Find an entity',entity:'Select an entity',noEntities:'This project has no entities yet',noMatches:'No matching entities',
  choose:'Select an entity to inspect its sources',events:'Event entries',pending:'Behavior analysis is not ready. Existing scripts and component settings remain available.',noEvents:'The analysis lists no event entries. This does not establish that the entity has no behavior.',
  stale:'This record belongs to an older version and is no longer shown as current project content.',more:'Content is truncated. Use behavior queries to inspect the complete structure.',
  sources:'Sources','source-script':'Script','source-declarative-component':'Component settings','source-runtime-adapter':'Runtime adapter',unknown:'Unknown relation',established:'Static structure',
  category:'Category',kind:'Kind',allKinds:'All kinds',all:'All categories',scene:'Scene',other:'Other',asset:'File asset',template:'Creation template',preset:'Preset',instance:'Scene instance',
  geometry:'Geometry',lights:'Lights',materials:'Materials',textures:'Textures',models:'Models',scripts:'Scripts',catalogPending:'The project resource catalog is not ready. Existing creation, assignment and script controls remain available below.',emptyCatalog:'No catalog entries in this category.',unavailable:'Unavailable',locate:'Locate source',
  dependenciesUnknown:'Dependencies are unknown',usageUnknown:'Usage is unknown',unusedInapplicable:'Unused-asset filtering does not apply',sourceDetails:'Source location',locationPending:'Source location service is not ready.',failed:'The action did not finish. Try again.',
  manualInspect:'Open hierarchy & properties',manualScript:'Open script editor',sourceHint:'This view shows the source reference. The project service verifies its version before navigating.',
  'resource.locate':'Locate source','asset.assign':'Assign asset','asset.inspect':'Inspect asset','template.create':'Create object','preset.apply':'Apply preset','instance.inspect':'Inspect instance',
};
export function workspaceText(language: WorkspaceLanguage, key: keyof typeof zh): string { return (language === 'en' ? en : zh)[key]; }
