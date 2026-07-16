import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captionsFromSubtitle, parseSubtitle, reflowWords, replaceCaptionsInRange, shiftCaptions, validateCaptions } from '../lib/captions.mjs';
import { openDatabase, projectStore } from '../lib/db.mjs';
import { WhisperService } from '../lib/whisper.mjs';

const word=(id,text,start,end,extra={})=>({id,text,start,end,spaceBefore:id!=='a',needsReview:false,reviewStatus:'approved',timingSource:'whisper',...extra});

test('automatic reflow preserves word ids and timestamps and breaks on silence',()=>{
  const words=[word('a','one',0,.4),word('b','two',.4,.8),word('c','three',1.2,1.6),word('d','four',1.6,2)];
  const captions=reflowWords(words,{maxWords:5,pauseThreshold:.25,cps:17,maxDuration:4,language:'en'});
  assert.equal(captions.length,2);
  assert.deepEqual(captions.flatMap(caption=>caption.words).map(item=>[item.id,item.start,item.end]),words.map(item=>[item.id,item.start,item.end]));
});

test('Thai target word count stays balanced without cutting dependent fragments',()=>{
  const words=[word('a','หิน',.54,1.08,{spaceBefore:false}),word('b','พันปี',1.08,1.84,{spaceBefore:false}),word('c','กลาย',2.08,2.33,{spaceBefore:false}),word('d','เป็น',2.33,2.60,{spaceBefore:false}),word('e','ปราศ',2.67,2.97,{spaceBefore:false}),word('f','า',2.97,3.05,{spaceBefore:false}),word('g','ทสา',3.05,3.38,{spaceBefore:false}),word('h','ย',3.38,3.42,{spaceBefore:false}),word('i','ฟ้า',3.42,3.72,{spaceBefore:false}),word('j','ตระการ',3.83,4.5,{spaceBefore:false}),word('k','ตา',4.5,4.74,{spaceBefore:false}),word('l','แต้ๆ',4.74,5.14,{spaceBefore:false})];
  const captions=reflowWords(words,{maxWords:3,pauseThreshold:.25,softPauseThreshold:.08,language:'th'});
  assert.deepEqual(captions.map(caption=>caption.text),['หินพันปี','กลายเป็นปราศา','ทสายฟ้า','ตระการตาแต้ๆ']);
  assert.ok(captions.every(caption=>caption.words.length<=4));
  assert.deepEqual(captions.flatMap(caption=>caption.words).map(item=>item.id),words.map(item=>item.id));
});

test('target three distributes long speech phrases as groups of three or four',()=>{
  const words=Array.from({length:10},(_,index)=>word(String(index),String(index),index*.2,index*.2+.18,{spaceBefore:false,speechRegionId:'speech'}));
  const captions=reflowWords(words,{maxWords:3,language:'th'});
  assert.deepEqual(captions.map(caption=>caption.words.length),[3,3,4]);
});

test('target three keeps the full first group before a two-word remainder',()=>{
  const words=Array.from({length:5},(_,index)=>word(String(index),String(index),index*.2,index*.2+.18,{spaceBefore:false,speechRegionId:'speech'}));
  assert.deepEqual(reflowWords(words,{maxWords:3,language:'th'}).map(caption=>caption.words.length),[3,2]);
});

test('SRT and VTT import tolerate BOM, line endings and cue settings',()=>{
  const srt='\uFEFF1\r\n00:00:00,000 --> 00:00:01,000\r\nสวัสดีครับ\r\n\r\n2\r\n00:00:01,200 --> 00:00:02,000\r\nทดสอบ';
  const captions=captionsFromSubtitle(srt,{format:'srt',language:'th'});
  assert.equal(captions.length,2);assert.ok(captions.every(caption=>caption.words.every(item=>item.timingSource==='estimated'&&item.reviewStatus==='pending')));
  const vtt='WEBVTT\n\n00:00.000 --> 00:01.000 line:90%\n<b>Hello</b>';
  assert.equal(parseSubtitle(vtt,{format:'vtt'})[0].text,'Hello');
});

test('subtitle import rejects overlapping cues',()=>{
  const source='1\n00:00:00,000 --> 00:00:02,000\nA\n\n2\n00:00:01,500 --> 00:00:03,000\nB';
  assert.throws(()=>parseSubtitle(source),/ซ้อน/);
});

test('global shift clamps to zero and project duration without changing durations',()=>{
  const source=[{id:'c',start:.2,end:1.2,text:'one',words:[word('a','one',.2,1.2)]}];
  const left=shiftCaptions(source,-2,3);assert.equal(left[0].start,0);assert.equal(left[0].end,1);
  const right=shiftCaptions(source,5,2);assert.equal(right[0].end,2);assert.equal(right[0].start,1);
});

test('partial replacement preserves unrelated word ids and timings',()=>{
  const original=[{id:'old',start:0,end:3,text:'one old three',words:[word('a','one',0,.8),word('b','old',1,1.8),word('c','three',2,3)]}];
  const candidate=[{id:'new',start:1,end:1.8,text:'new',words:[word('x','new',1,1.8,{reviewStatus:'pending',needsReview:true})]}];
  const merged=replaceCaptionsInRange(original,candidate,{start:1,end:1.8},{maxWords:5,language:'en'}),flat=merged.flatMap(caption=>caption.words);
  assert.deepEqual(flat.filter(item=>item.id!=='x').map(item=>[item.id,item.start,item.end]),[['a',0,.8],['c',2,3]]);
  assert.equal(flat.find(item=>item.id==='x').text,'new');
});

test('caption schema v3 normalizes review and timing fields',()=>{
  const captions=validateCaptions([{id:'c',start:0,end:1,text:'word',words:[{id:'w',text:'word',start:0,end:1,needsReview:true}]}]);
  assert.equal(captions[0].words[0].reviewStatus,'pending');assert.equal(captions[0].words[0].timingSource,'whisper');
});

test('Whisper profiles map accurate to Q8 and CPU modes to Q5',()=>{
  const service=new WhisperService({root:'C:/app',models:{accurate:'q8.bin',balanced:'q5.bin',fast:'q5.bin'},vadModel:'vad.bin'});
  assert.equal(service.profileCandidates('accurate')[0].model,'q8.bin');assert.equal(service.profileCandidates('accurate')[1].profile,'balanced');
  assert.equal(service.profileCandidates('fast')[0].mode,'cpu');assert.equal(service.profileCandidates('fast')[0].beam,1);
});

test('database migrates words to schema v3 and persists partial job result',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sublabs-v3-')),file=path.join(directory,'test.db'),now=new Date().toISOString();let db=openDatabase(file),store=projectStore(db);
  store.create({id:'p',name:'x.mp4',file:'x',mediaUrl:'/x',width:640,height:360,duration:3,createdAt:now});
  db.prepare('UPDATE projects SET captions_json=?,schema_version=2 WHERE id=?').run(JSON.stringify([{id:'c',start:0,end:1,text:'word',words:[{id:'w',text:'word',start:0,end:1,needsReview:true}]}]),'p');
  store.createJob({id:'j',projectId:'p',status:'complete',step:5,progress:100,label:'done',createdAt:now,options:{range:{start:0,end:1}}});store.updateJob('j',{result_json:{candidateCaptions:[],applied:false}});db.close();
  db=openDatabase(file);store=projectStore(db);assert.equal(store.get('p').schema_version,3);assert.equal(store.get('p').captions[0].words[0].reviewStatus,'pending');assert.equal(JSON.parse(store.getJob('j').result_json).applied,false);db.close();await rm(directory,{recursive:true,force:true});
});

test('project keeps its selected caption word target',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sublabs-target-')),file=path.join(directory,'test.db'),now=new Date().toISOString(),db=openDatabase(file),store=projectStore(db);
  store.create({id:'p',name:'x.mp4',file:'x',mediaUrl:'/x',width:640,height:360,duration:3,createdAt:now});
  store.updateCaptions('p',[], 'th',3);assert.equal(store.get('p').words_per_caption,3);db.close();await rm(directory,{recursive:true,force:true});
});
