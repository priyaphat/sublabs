import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL, media_url TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, duration REAL NOT NULL,
      captions_json TEXT NOT NULL DEFAULT '[]', style_json TEXT NOT NULL DEFAULT '{}',
      language TEXT NOT NULL DEFAULT 'th', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, progress REAL,
      label TEXT NOT NULL, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      options_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL, progress REAL, label TEXT NOT NULL, error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, result_path TEXT, options_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
  try { db.exec(`ALTER TABLE jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'`); } catch {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN waveform_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN speech_regions_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`); } catch {}
  let wordTargetAdded=false;
  try { db.exec(`ALTER TABLE projects ADD COLUMN words_per_caption INTEGER NOT NULL DEFAULT 5`);wordTargetAdded=true; } catch {}
  if(wordTargetAdded){
    const latest=db.prepare('SELECT options_json FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 1'),saveTarget=db.prepare('UPDATE projects SET words_per_caption=? WHERE id=?');
    for(const project of db.prepare('SELECT id FROM projects').all()){
      try{const target=Number(JSON.parse(latest.get(project.id)?.options_json||'{}').wordsPerCaption);if(Number.isInteger(target)&&target>=1&&target<=12)saveTarget.run(target,project.id)}catch{}
    }
  }
  const legacy=db.prepare('SELECT id,captions_json,style_json,schema_version FROM projects WHERE schema_version<3').all();
  const migrate=db.prepare('UPDATE projects SET captions_json=?,style_json=?,schema_version=3 WHERE id=?');
  for(const row of legacy){
    try{
      const captions=JSON.parse(row.captions_json||'[]').map(caption=>({...caption,words:(caption.words||[]).map(word=>({...word,rawConfidence:word.rawConfidence??word.confidence??null,reviewScore:word.reviewScore??null,needsReview:Boolean(word.needsReview),reviewStatus:['pending','approved','edited'].includes(word.reviewStatus)?word.reviewStatus:(word.needsReview?'pending':'approved'),timingSource:['whisper','estimated','manual'].includes(word.timingSource)?word.timingSource:'whisper'}))}));
      const style={...JSON.parse(row.style_json||'{}'),schemaVersion:3};migrate.run(JSON.stringify(captions),JSON.stringify(style),row.id);
    }catch{}
  }
  return db;
}

const parse = row => row && ({ ...row, captions: JSON.parse(row.captions_json || '[]'), style: JSON.parse(row.style_json || '{}'),waveform:JSON.parse(row.waveform_json||'[]'),speechRegions:JSON.parse(row.speech_regions_json||'[]') });
export function projectStore(db) {
  return {
    create(p) { db.prepare(`INSERT INTO projects(id,name,file_path,media_url,width,height,duration,captions_json,style_json,language,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.name,p.file,p.mediaUrl,p.width,p.height,p.duration,'[]','{}',p.language||'th',3,p.createdAt,p.createdAt); return this.get(p.id); },
    get(id) { return parse(db.prepare('SELECT * FROM projects WHERE id=?').get(id)); },
    list(limit=30){return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(Math.max(1,Math.min(100,Number(limit)||30))).map(parse)},
    delete(id){const value=this.get(id);if(value)db.prepare('DELETE FROM projects WHERE id=?').run(id);return value},
    updateCaptions(id, captions, language='th',wordsPerCaption=null) { const target=Number(wordsPerCaption),valid=Number.isInteger(target)&&target>=1&&target<=12;if(valid)db.prepare('UPDATE projects SET captions_json=?,language=?,words_per_caption=?,schema_version=3,updated_at=? WHERE id=?').run(JSON.stringify(captions),language,target,new Date().toISOString(),id);else db.prepare('UPDATE projects SET captions_json=?,language=?,schema_version=3,updated_at=? WHERE id=?').run(JSON.stringify(captions),language,new Date().toISOString(),id);return this.get(id); },
    updateStyle(id, style) { db.prepare('UPDATE projects SET style_json=?,updated_at=? WHERE id=?').run(JSON.stringify(style),new Date().toISOString(),id); return this.get(id); },
    updateAnalysis(id,{waveform,speechRegions}){const current=this.get(id);db.prepare('UPDATE projects SET waveform_json=?,speech_regions_json=?,updated_at=? WHERE id=?').run(JSON.stringify(waveform??current?.waveform??[]),JSON.stringify(speechRegions??current?.speechRegions??[]),new Date().toISOString(),id);return this.get(id)},
    createJob(j) { db.prepare(`INSERT INTO jobs(id,project_id,status,step,progress,label,options_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(j.id,j.projectId,j.status,j.step,j.progress,j.label,JSON.stringify(j.options||{}),j.createdAt,j.createdAt); return this.getJob(j.id); },
    getJob(id) { return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); },
    updateJob(id, values) { const allowed=['status','step','progress','label','error','cancel_requested','result_json']; const pairs=Object.keys(values).filter(k=>allowed.includes(k)); if(!pairs.length)return this.getJob(id); const sql=`UPDATE jobs SET ${pairs.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`; db.prepare(sql).run(...pairs.map(k=>k==='result_json'&&typeof values[k]!=='string'?JSON.stringify(values[k]):values[k]),new Date().toISOString(),id); return this.getJob(id); },
    createExport(value){db.prepare(`INSERT INTO exports(id,project_id,status,progress,label,options_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(value.id,value.projectId,value.status,value.progress,value.label,JSON.stringify(value.options||{}),value.createdAt,value.createdAt);return this.getExport(value.id)},
    getExport(id){return db.prepare('SELECT * FROM exports WHERE id=?').get(id)},
    listExports(projectId){return db.prepare('SELECT * FROM exports WHERE project_id=? ORDER BY created_at DESC').all(projectId)},
    updateExport(id,values){const allowed=['status','progress','label','error','cancel_requested','result_path'];const pairs=Object.keys(values).filter(key=>allowed.includes(key));if(!pairs.length)return this.getExport(id);db.prepare(`UPDATE exports SET ${pairs.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>values[key]),new Date().toISOString(),id);return this.getExport(id)},
    recoverJobs() { db.exec(`UPDATE jobs SET status='failed',label='หยุดเนื่องจากโปรแกรมปิด',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','running'); UPDATE exports SET status='failed',label='หยุดเนื่องจากโปรแกรมปิด',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','running')`); },
  };
}
