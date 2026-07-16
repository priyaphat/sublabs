import test from 'node:test';
import assert from 'node:assert/strict';
import { findWeakSpeechRegions, hypothesesDisagree, markSpeechRegionForReview, replaceSpeechRegionWords, retryCandidateWins } from '../lib/transcription-quality.mjs';
import { alignWordsToSpeechRegions, reflowWords, tokensToWords } from '../lib/captions.mjs';

const word=(id,text,start,end,score=.85)=>({id,text,start,end,reviewScore:score,reviewStatus:'approved',needsReview:false,timingSource:'whisper'});

test('speech region with a missing tail is selected for retry',()=>{
  const region={id:'speech-8',start:31.95,end:35.92},words=[word('a','มดี',32.04,32.52),word('b','เจ้า',34.12,34.76)];
  assert.deepEqual(findWeakSpeechRegions(words,[region]).map(item=>item.id),['speech-8']);
});

test('short speech region with suspiciously few words is selected for retry',()=>{
  const region={id:'speech-0',start:0,end:1.39},words=[word('a','คน',.02,.29),word('b','นัก',.39,.75),word('c','ขนาด',.75,1.21)];
  assert.deepEqual(findWeakSpeechRegions(words,[region]).map(item=>item.id),['speech-0']);
});

test('edge coverage alone does not replace a different transcription',()=>{
  const region={start:31.95,end:35.92},before=[word('a','เดิม',32.04,34.76,.9)],after=[word('b','ใหม่',31.96,35.91,.78)];
  assert.equal(retryCandidateWins(before,after,region),false);
  assert.equal(retryCandidateWins(before,[word('c','แย่',31.96,35.91,.5)],region),false);
});

test('matching text can replace timing when VAD edge coverage improves',()=>{
  const region={start:31.95,end:35.92},before=[word('a','same',32.4,35.2,.9)],after=[word('b','same',31.96,35.91,.85)];
  assert.equal(retryCandidateWins(before,after,region),true);
});

test('retry wins when it recovers two omitted words in a short speech region',()=>{
  const region={start:0,end:1.39},before=[word('a','คน',.02,.29,.86),word('b','นัก',.39,.75,.86),word('c','ขนาด',.75,1.21,.86)],after=[word('d','คน',.02,.17,.9),word('e','นัก',.17,.41,.9),word('f','ขนาด',.41,.73,.9),word('g','เลย',.73,.99,.9),word('h','เจ้า',.99,1.38,.9)];
  assert.equal(retryCandidateWins(before,after,region),true);
});

test('one recovered tail word wins when it also improves region edge coverage',()=>{
  const region={start:28.78,end:31.6},before=[word('a','ทำได้',30.7,31.36,.9)],after=[word('b','ทำได้',30.7,31.2,.9),word('c','แล้ว',31.2,31.58,.85)];
  assert.equal(retryCandidateWins(before,after,region),true);
});

test('Thai tokenizer fragment inflation does not replace a cleaner hypothesis',()=>{
  const region={start:2.32,end:3.92};
  const before=[
    word('a','\u0E27\u0E31\u0E19',2.38,2.57),
    word('b','\u0E19\u0E35\u0E49',2.57,2.7),
    word('c','\u0E40\u0E2E\u0E32',2.7,2.89),
    word('d','\u0E15\u0E49\u0E2D\u0E07',2.89,3.13),
    word('e','\u0E22\u0E30',3.13,3.32),
    word('f','\u0E2E\u0E37\u0E2D',3.32,3.55),
    word('g','\u0E44\u0E14\u0E49',3.55,3.72),
  ];
  const fragmented=[
    word('h','\u0E27\u0E31\u0E19',2.38,2.57),
    word('i','\u0E19\u0E35\u0E49',2.57,2.7),
    word('j','\u0E40\u0E02\u0E32',2.7,2.89),
    word('k','\u0E15\u0E49\u0E2D',2.89,3.13),
    word('l','\u0E07\u0E2D\u0E22\u0E49',3.13,3.33),
    word('m','\u0E32',3.33,3.38),
    word('n','\u0E04\u0E37\u0E2D',3.4,3.57),
    word('o','\u0E44\u0E14\u0E49',3.57,3.72),
  ];
  assert.equal(retryCandidateWins(before,fragmented,region),false);
});

test('different hypotheses are detected even when confidence is high',()=>{
  const region={start:0,end:1},before=[word('a','เฮา',0,.5,.95)],after=[word('b','เขา',0,.5,.96)];
  assert.equal(hypothesesDisagree(before,after,region),true);
  const reviewed=markSpeechRegionForReview(before,after,region);assert.equal(reviewed[0].reviewStatus,'pending');assert.equal(reviewed[0].reviewReason,'pass-disagreement');
});

test('tokenization-only changes with the same text are not disagreements',()=>{
  const region={start:0,end:1},before=[word('a','โอ้',0,.4),word('b','ย',.4,.8)],after=[word('c','โอ้ย',0,.8)];
  assert.equal(hypothesesDisagree(before,after,region),false);
});

test('accepted retry words become pending review and keep unrelated words',()=>{
  const region={start:10,end:12},outside=word('outside','ก่อน',8,9),candidate=[word('new','ใหม่',10.1,11.9)];
  const result=replaceSpeechRegionWords([outside,word('old','เดิม',10.2,10.8)],candidate,region);
  assert.equal(result[0].id,'outside');assert.equal(result[1].reviewStatus,'pending');assert.equal(result[1].reviewReason,'coverage-retry');
});

test('accepted retry keeps consensus words approved and flags only recovered words',()=>{
  const region={start:0,end:2},before=[word('a','เรา',0,.4),word('b','ทำได้',.4,1.2)],candidate=[word('c','เรา',0,.35),word('d','ทำได้',.35,1.1),word('e','แล้ว',1.1,1.8)];
  const result=replaceSpeechRegionWords(before,candidate,region);
  assert.deepEqual(result.map(item=>item.reviewStatus),['approved','approved','pending']);
});

test('disagreement review leaves matching words approved',()=>{
  const region={start:0,end:2},before=[word('a','เรา',0,.4),word('b','เฮา',.4,.8),word('c','ได้',.8,1.2)],candidate=[word('x','เรา',0,.4),word('y','เขา',.4,.8),word('z','ได้',.8,1.2)];
  const result=markSpeechRegionForReview(before,candidate,region);
  assert.deepEqual(result.map(item=>item.reviewStatus),['approved','pending','approved']);
});

test('Thai dependent-mark fragments enter review queue',()=>{
  const words=tokensToWords([{text:'าก',start:0,end:.2,confidence:.95}],'th');
  assert.equal(words[0].needsReview,true);assert.equal(words[0].reviewStatus,'pending');
});

test('timing clamp changes automatic approved word to pending',()=>{
  const words=alignWordsToSpeechRegions([word('a','ต้อง',1,1.05)],[{id:'speech',start:.9,end:1.2}]);
  assert.equal(words[0].needsReview,true);assert.equal(words[0].reviewStatus,'pending');
});

test('Thai repetition mark stays attached to previous caption text',()=>{
  const captions=reflowWords([word('a','ลำ',0,.2),word('b','แต้',.2,.5),word('c','ๆ',.56,.7),word('d','เจ้า',.7,1)],{maxWords:2,softPauseThreshold:.05,language:'th'});
  assert.equal(captions.some(caption=>caption.text==='ๆ'),false);
  assert.match(captions.map(caption=>caption.text).join(''),/แต้ๆ/);
});
