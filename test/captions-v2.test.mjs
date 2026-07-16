import test from 'node:test';
import assert from 'node:assert/strict';
import { alignWordsToSpeechRegions, applyGlossary, reconcileEditedCaption, tokensToWords, validateCaptions } from '../lib/captions.mjs';

test('speech regions remove words in silence without text-length caps',()=>{
  const words=alignWordsToSpeechRegions([{id:'long',text:'slow',start:1,end:2.2},{id:'noise',text:'noise',start:3,end:3.2}],[{id:'speech-1',start:.9,end:2.3}]);
  assert.equal(words.length,1);assert.equal(words[0].end,2.2);assert.equal(words[0].speechRegionId,'speech-1');
});
test('glossary merges matching tokenized terms',()=>{
  const words=applyGlossary([{id:'a',text:'New',start:0,end:.2},{id:'b',text:'York',start:.2,end:.5}],['New York']);
  assert.equal(words.length,1);assert.equal(words[0].text,'New York');assert.equal(words[0].end,.5);
});
test('word diff preserves unchanged timings and replacement interval',()=>{
  const caption={id:'c',start:0,end:1,text:'hello world now',words:[{id:'a',text:'hello',start:0,end:.2,spaceBefore:false},{id:'b',text:'world',start:.5,end:.8,spaceBefore:true},{id:'c',text:'now',start:.8,end:1,spaceBefore:true}]};
  const inserted=reconcileEditedCaption(caption,'hello brave world now','en');assert.equal(inserted.words[0].start,0);assert.equal(inserted.words[2].start,.5);assert.equal(inserted.words[3].start,.8);
  const replaced=reconcileEditedCaption(caption,'hello planet now','en');assert.equal(replaced.words[1].start,.5);assert.equal(replaced.words[1].end,.8);assert.equal(replaced.words[2].start,.8);
});
test('caption validation rejects text and word mismatch',()=>assert.throws(()=>validateCaptions([{id:'c',start:0,end:1,text:'wrong',words:[{id:'w',text:'right',start:0,end:1}]}])));
test('Thai word is not split merely because Whisper opened a new segment',()=>{const words=tokensToWords([{text:'คว',start:1,end:1.2},{text:'าม',start:1.2,end:1.4,segmentBreak:true}],'th');assert.equal(words.length,1);assert.equal(words[0].text,'ความ')});
test('adjacent Whisper segments do not force a Thai caption break without silence',()=>{const words=tokensToWords([{text:'ก่าย',start:1,end:1.2},{text:'แล้ว',start:1.2,end:1.5,segmentBreak:true}],'th');assert.equal(words[1].phraseBreak,false)});
test('leading spaces emitted by Whisper do not become Thai phrase breaks',()=>{const words=tokensToWords([{text:' วิทยาศาสตร์',start:1,end:1.4},{text:' ก่าย',start:1.4,end:1.7,segmentBreak:true},{text:' แล้ว',start:1.7,end:2,segmentBreak:true}],'th');assert.equal(words.map(word=>word.spaceBefore).some(Boolean),false);assert.equal(words.map(word=>word.phraseBreak).some(Boolean),false)});
