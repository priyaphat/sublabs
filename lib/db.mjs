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
    );
    CREATE TABLE IF NOT EXISTS style_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, style_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS style_presets_name_unique ON style_presets(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS voice_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user',
      license TEXT NOT NULL DEFAULT 'user-provided', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_styles (
      id TEXT PRIMARY KEY, voice_id TEXT NOT NULL REFERENCES voice_presets(id) ON DELETE CASCADE,
      emotion TEXT NOT NULL, reference_text TEXT NOT NULL, reference_path TEXT NOT NULL,
      preview_url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(voice_id, emotion)
    );
    CREATE TABLE IF NOT EXISTS dub_clips (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      start_time REAL NOT NULL, end_time REAL NOT NULL, text TEXT NOT NULL,
      voice_style_id TEXT NOT NULL REFERENCES voice_styles(id),
      audio_path TEXT, audio_url TEXT, actual_duration REAL,
      fit_status TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'queued',
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dub_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      clip_id TEXT NOT NULL REFERENCES dub_clips(id) ON DELETE CASCADE,
      status TEXT NOT NULL, progress REAL, label TEXT NOT NULL, error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dub_takes (
      id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES dub_clips(id) ON DELETE CASCADE,
      take_index INTEGER NOT NULL, audio_path TEXT, audio_url TEXT, actual_duration REAL,
      fit_status TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'queued',
      error TEXT, seed INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(clip_id, take_index)
    );`);
  try { db.exec(`ALTER TABLE jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'`); } catch {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN waveform_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN speech_regions_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE projects ADD COLUMN dub_pronunciations_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE dub_clips ADD COLUMN spoken_text TEXT`); } catch {}
  try { db.exec(`ALTER TABLE dub_clips ADD COLUMN speed REAL NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE dub_clips ADD COLUMN pause_before REAL NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE dub_clips ADD COLUMN pause_after REAL NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE dub_clips ADD COLUMN selected_take_id TEXT`); } catch {}
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

const parse = row => row && ({ ...row, captions: JSON.parse(row.captions_json || '[]'), style: JSON.parse(row.style_json || '{}'),waveform:JSON.parse(row.waveform_json||'[]'),speechRegions:JSON.parse(row.speech_regions_json||'[]'),dubPronunciations:JSON.parse(row.dub_pronunciations_json||'[]') });
export function projectStore(db) {
  return {
    create(p) { db.prepare(`INSERT INTO projects(id,name,file_path,media_url,width,height,duration,captions_json,style_json,language,schema_version,has_audio,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.name,p.file,p.mediaUrl,p.width,p.height,p.duration,'[]','{}',p.language||'th',3,p.hasAudio===false?0:1,p.createdAt,p.createdAt); return this.get(p.id); },
    get(id) { return parse(db.prepare('SELECT * FROM projects WHERE id=?').get(id)); },
    list(limit=30){return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(Math.max(1,Math.min(100,Number(limit)||30))).map(parse)},
    delete(id){const value=this.get(id);if(value)db.prepare('DELETE FROM projects WHERE id=?').run(id);return value},
    updateCaptions(id, captions, language='th',wordsPerCaption=null) { const target=Number(wordsPerCaption),valid=Number.isInteger(target)&&target>=1&&target<=12;if(valid)db.prepare('UPDATE projects SET captions_json=?,language=?,words_per_caption=?,schema_version=3,updated_at=? WHERE id=?').run(JSON.stringify(captions),language,target,new Date().toISOString(),id);else db.prepare('UPDATE projects SET captions_json=?,language=?,schema_version=3,updated_at=? WHERE id=?').run(JSON.stringify(captions),language,new Date().toISOString(),id);return this.get(id); },
    updateStyle(id, style) { db.prepare('UPDATE projects SET style_json=?,updated_at=? WHERE id=?').run(JSON.stringify(style),new Date().toISOString(),id); return this.get(id); },
    updateDubSettings(id,{pronunciations=[]}){db.prepare('UPDATE projects SET dub_pronunciations_json=?,updated_at=? WHERE id=?').run(JSON.stringify(pronunciations),new Date().toISOString(),id);return this.get(id)},
    updateAnalysis(id,{waveform,speechRegions}){const current=this.get(id);db.prepare('UPDATE projects SET waveform_json=?,speech_regions_json=?,updated_at=? WHERE id=?').run(JSON.stringify(waveform??current?.waveform??[]),JSON.stringify(speechRegions??current?.speechRegions??[]),new Date().toISOString(),id);return this.get(id)},
    createJob(j) { db.prepare(`INSERT INTO jobs(id,project_id,status,step,progress,label,options_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(j.id,j.projectId,j.status,j.step,j.progress,j.label,JSON.stringify(j.options||{}),j.createdAt,j.createdAt); return this.getJob(j.id); },
    getJob(id) { return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); },
    updateJob(id, values) { const allowed=['status','step','progress','label','error','cancel_requested','result_json']; const pairs=Object.keys(values).filter(k=>allowed.includes(k)); if(!pairs.length)return this.getJob(id); const sql=`UPDATE jobs SET ${pairs.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`; db.prepare(sql).run(...pairs.map(k=>k==='result_json'&&typeof values[k]!=='string'?JSON.stringify(values[k]):values[k]),new Date().toISOString(),id); return this.getJob(id); },
    createExport(value){db.prepare(`INSERT INTO exports(id,project_id,status,progress,label,options_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(value.id,value.projectId,value.status,value.progress,value.label,JSON.stringify(value.options||{}),value.createdAt,value.createdAt);return this.getExport(value.id)},
    getExport(id){return db.prepare('SELECT * FROM exports WHERE id=?').get(id)},
    listExports(projectId){return db.prepare('SELECT * FROM exports WHERE project_id=? ORDER BY created_at DESC').all(projectId)},
    updateExport(id,values){const allowed=['status','progress','label','error','cancel_requested','result_path'];const pairs=Object.keys(values).filter(key=>allowed.includes(key));if(!pairs.length)return this.getExport(id);db.prepare(`UPDATE exports SET ${pairs.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>values[key]),new Date().toISOString(),id);return this.getExport(id)},
    createStylePreset(value){db.prepare('INSERT INTO style_presets(id,name,style_json,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(value.id,value.name,JSON.stringify(value.style||{}),value.source||'user',value.createdAt,value.createdAt);return this.getStylePreset(value.id)},
    getStylePreset(id){const value=db.prepare('SELECT * FROM style_presets WHERE id=?').get(id);return value&&{...value,style:JSON.parse(value.style_json||'{}')}},
    listStylePresets(){return db.prepare('SELECT * FROM style_presets ORDER BY created_at,name COLLATE NOCASE').all().map(value=>({...value,style:JSON.parse(value.style_json||'{}')}))},
    deleteStylePreset(id){const value=this.getStylePreset(id);if(value)db.prepare('DELETE FROM style_presets WHERE id=?').run(id);return value},
    createVoice(value){db.prepare(`INSERT INTO voice_presets(id,name,source,license,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(value.id,value.name,value.source||'user',value.license||'user-provided',value.createdAt,value.createdAt);return this.getVoice(value.id)},
    getVoice(id){const voice=db.prepare('SELECT * FROM voice_presets WHERE id=?').get(id);return voice&&{...voice,styles:this.listVoiceStyles(id)}},
    listVoices(){return db.prepare('SELECT * FROM voice_presets ORDER BY name COLLATE NOCASE').all().map(voice=>({...voice,styles:this.listVoiceStyles(voice.id)}))},
    updateVoice(id,values){const allowed=['name','source','license'],pairs=Object.keys(values).filter(key=>allowed.includes(key));if(!pairs.length)return this.getVoice(id);db.prepare(`UPDATE voice_presets SET ${pairs.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>values[key]),new Date().toISOString(),id);return this.getVoice(id)},
    deleteVoice(id){const value=this.getVoice(id);if(value)db.prepare('DELETE FROM voice_presets WHERE id=?').run(id);return value},
    createVoiceStyle(value){db.prepare(`INSERT INTO voice_styles(id,voice_id,emotion,reference_text,reference_path,preview_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(value.id,value.voiceId,value.emotion,value.referenceText,value.referencePath,value.previewUrl,value.createdAt,value.createdAt);return this.getVoiceStyle(value.id)},
    getVoiceStyle(id){return db.prepare('SELECT * FROM voice_styles WHERE id=?').get(id)},
    listVoiceStyles(voiceId){return db.prepare('SELECT * FROM voice_styles WHERE voice_id=? ORDER BY created_at').all(voiceId)},
    deleteVoiceStyle(id){const value=this.getVoiceStyle(id);if(value)db.prepare('DELETE FROM voice_styles WHERE id=?').run(id);return value},
    voiceUsage(styleId){return Number(db.prepare('SELECT COUNT(*) AS count FROM dub_clips WHERE voice_style_id=?').get(styleId)?.count||0)},
    createDubClip(value){db.prepare(`INSERT INTO dub_clips(id,project_id,start_time,end_time,text,spoken_text,voice_style_id,speed,pause_before,pause_after,fit_status,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.id,value.projectId,value.start,value.end,value.text,value.spokenText||value.text,value.voiceStyleId,value.speed||1,value.pauseBefore||0,value.pauseAfter||0,value.fitStatus||'pending',value.status||'queued',value.createdAt,value.createdAt);return this.getDubClip(value.id)},
    getDubClip(id){const clip=db.prepare('SELECT * FROM dub_clips WHERE id=?').get(id);return clip&&{...clip,takes:this.listDubTakes(id)}},
    listDubClips(projectId){return db.prepare('SELECT * FROM dub_clips WHERE project_id=? ORDER BY start_time,id').all(projectId).map(clip=>({...clip,takes:this.listDubTakes(clip.id)}))},
    updateDubClip(id,values){const map={start:'start_time',end:'end_time',text:'text',spokenText:'spoken_text',voiceStyleId:'voice_style_id',speed:'speed',pauseBefore:'pause_before',pauseAfter:'pause_after',selectedTakeId:'selected_take_id',audioPath:'audio_path',audioUrl:'audio_url',actualDuration:'actual_duration',fitStatus:'fit_status',status:'status',error:'error'},pairs=Object.keys(values).filter(key=>map[key]);if(!pairs.length)return this.getDubClip(id);db.prepare(`UPDATE dub_clips SET ${pairs.map(key=>`${map[key]}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>values[key]),new Date().toISOString(),id);return this.getDubClip(id)},
    deleteDubClip(id){const value=this.getDubClip(id);if(value)db.prepare('DELETE FROM dub_clips WHERE id=?').run(id);return value},
    createDubTake(value){db.prepare(`INSERT INTO dub_takes(id,clip_id,take_index,audio_path,audio_url,actual_duration,fit_status,status,error,seed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.id,value.clipId,value.takeIndex,value.audioPath||null,value.audioUrl||null,value.actualDuration||null,value.fitStatus||'pending',value.status||'queued',value.error||null,value.seed||null,value.createdAt,value.createdAt);return this.getDubTake(value.id)},
    getDubTake(id){return db.prepare('SELECT * FROM dub_takes WHERE id=?').get(id)},
    listDubTakes(clipId){return db.prepare('SELECT * FROM dub_takes WHERE clip_id=? ORDER BY take_index').all(clipId)},
    updateDubTake(id,values){const map={audioPath:'audio_path',audioUrl:'audio_url',actualDuration:'actual_duration',fitStatus:'fit_status',status:'status',error:'error'},pairs=Object.keys(values).filter(key=>map[key]);if(!pairs.length)return this.getDubTake(id);db.prepare(`UPDATE dub_takes SET ${pairs.map(key=>`${map[key]}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>values[key]),new Date().toISOString(),id);return this.getDubTake(id)},
    deleteDubTakes(clipId){const values=this.listDubTakes(clipId);db.prepare('DELETE FROM dub_takes WHERE clip_id=?').run(clipId);return values},
    createDubJob(value){db.prepare(`INSERT INTO dub_jobs(id,project_id,clip_id,status,progress,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(value.id,value.projectId,value.clipId,value.status,value.progress,value.label,value.createdAt,value.createdAt);return this.getDubJob(value.id)},
    getDubJob(id){return db.prepare('SELECT * FROM dub_jobs WHERE id=?').get(id)},
    updateDubJob(id,values){const allowed=['status','progress','label','error','cancel_requested','result_json'],pairs=Object.keys(values).filter(key=>allowed.includes(key));if(!pairs.length)return this.getDubJob(id);db.prepare(`UPDATE dub_jobs SET ${pairs.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...pairs.map(key=>key==='result_json'&&typeof values[key]!=='string'?JSON.stringify(values[key]):values[key]),new Date().toISOString(),id);return this.getDubJob(id)},
    projectDubFiles(projectId){return this.listDubClips(projectId).flatMap(clip=>[clip.audio_path,...clip.takes.map(take=>take.audio_path)]).filter(Boolean)},
    recoverJobs() { db.exec(`UPDATE jobs SET status='failed',label='หยุดเนื่องจากโปรแกรมปิด',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','running'); UPDATE exports SET status='failed',label='หยุดเนื่องจากโปรแกรมปิด',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','running'); UPDATE dub_jobs SET status='failed',label='หยุดเนื่องจากโปรแกรมปิด',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','running'); UPDATE dub_clips SET status='failed',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','generating'); UPDATE dub_takes SET status='failed',error='Application restarted',updated_at=datetime('now') WHERE status IN ('queued','generating')`); },
  };
}
