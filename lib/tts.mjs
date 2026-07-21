import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class LocalTtsService{
  constructor({root,dataDir}){
    this.root=root;
    this.dataDir=dataDir;
    this.runtimeDir=path.join(root,'data','runtime');
    this.child=null;
    this.starting=null;
    this.mode=null;
    this.ready=false;
    this.lastError='';
    this.pending=new Map();
    this.stdoutBuffer='';
  }

  pythonCandidates(){
    return[
      process.env.SUBLABS_TTS_PYTHON,
      path.join(this.runtimeDir,'tts-python','Scripts','python.exe'),
      path.join(this.runtimeDir,'python311','python.exe'),
    ].filter(Boolean);
  }

  async pythonPath(){
    for(const candidate of this.pythonCandidates())try{await access(candidate);return candidate}catch{}
    return null;
  }

  async installed(){
    if(!await this.pythonPath())return false;
    try{await access(path.join(this.runtimeDir,'thonburian-tts','flowtts','inference.py'));return true}catch{return false}
  }

  async start(preferred='cuda'){
    const requested=preferred==='cpu'?'cpu':'cuda';
    if(this.child&&!this.child.killed&&this.ready&&this.mode===requested)return;
    if(this.starting)return this.starting;
    this.starting=this.#start(requested).finally(()=>{this.starting=null});
    return this.starting;
  }

  async #start(mode){
    await this.stop();
    const python=await this.pythonPath();
    if(!python)throw new Error('ยังไม่ได้ติดตั้งระบบสร้างเสียง กรุณารัน scripts/setup-tts.ps1');
    const worker=path.join(this.root,'scripts','tts-worker.py');
    this.ready=false;this.mode=mode;this.lastError='';
    const sourceRoot=path.join(this.runtimeDir,'thonburian-tts'),ffmpegDir=path.dirname(path.join(this.root,'node_modules','ffmpeg-static','ffmpeg.exe'));
    const env={...process.env,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',HF_HOME:path.join(this.dataDir,'models','tts'),HF_HUB_DISABLE_XET:'1',SUBLABS_TTS_DEVICE:mode,PYTHONPATH:[sourceRoot,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),PATH:[ffmpegDir,process.env.PATH].filter(Boolean).join(path.delimiter)};
    const child=this.child=spawn(python,['-u',worker],{cwd:this.root,windowsHide:true,env});
    child.stdout.on('data',data=>this.#onStdout(String(data)));
    child.stderr.on('data',data=>{this.lastError=(this.lastError+String(data)).slice(-12000)});
    child.on('close',()=>{if(this.child===child)this.child=null;this.ready=false;for(const item of this.pending.values())item.reject(new Error(this.lastError||'TTS worker หยุดทำงาน'));this.pending.clear()});
    for(let index=0;index<7200;index++){
      if(!this.child)throw new Error(this.lastError||'เปิด TTS worker ไม่สำเร็จ');
      if(this.ready)return;
      await wait(500);
    }
    await this.stop();
    throw new Error('โหลดโมเดลเสียงนานเกินกำหนด');
  }

  #onStdout(value){
    this.stdoutBuffer+=value;
    let newline;
    while((newline=this.stdoutBuffer.indexOf('\n'))>=0){
      const line=this.stdoutBuffer.slice(0,newline).trim();this.stdoutBuffer=this.stdoutBuffer.slice(newline+1);
      if(!line)continue;
      let message;try{message=JSON.parse(line)}catch{continue}
      if(message.type==='ready'){this.ready=true;this.mode=message.device||this.mode;continue}
      if(message.type==='startup_progress')continue;
      if(message.type==='startup_error'){this.lastError=message.error||'โหลดโมเดลไม่สำเร็จ';continue}
      const pending=this.pending.get(message.id);if(!pending)continue;
      this.pending.delete(message.id);
      if(message.ok)pending.resolve(message);else pending.reject(new Error(message.error||'สร้างเสียงไม่สำเร็จ'));
    }
  }

  async synthesize({text,referencePath,referenceText,outputPath,speed=1,seed=null}){
    await this.start('cuda').catch(async error=>{
      if(!/CUDA|cuda|memory|cublas|driver/i.test(String(error.message||error)))throw error;
      this.lastError=String(error.message||error);await this.start('cpu');
    });
    const request=()=>new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();this.pending.set(id,{resolve,reject});
      this.child.stdin.write(`${JSON.stringify({id,text,referencePath,referenceText,outputPath,speed,seed})}\n`,'utf8',error=>{if(error){this.pending.delete(id);reject(error)}});
    });
    try{return await request()}
    catch(error){
      if(this.mode==='cuda'&&/CUDA|cuda|memory|cublas|driver/i.test(String(error.message||error))){await this.start('cpu');return request()}
      throw error;
    }
  }

  status(){return{running:Boolean(this.child),ready:this.ready,mode:this.mode,error:this.lastError||null,license:'CC BY-NC-SA 4.0',commercialUse:false}}

  async stop(){
    const child=this.child;if(!child)return;
    this.child=null;this.ready=false;
    try{child.stdin.end()}catch{}
    if(!child.killed)child.kill();
    for(let index=0;index<20&&child.exitCode==null;index++)await wait(100);
    if(child.exitCode==null)child.kill('SIGKILL');
  }
}
