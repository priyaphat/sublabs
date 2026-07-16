import test from 'node:test';
import assert from 'node:assert/strict';
import { capWordDurations, thaiWords, tokensToWords, groupWords, normalizeEditedCaption, snapWordsToSpeech, validateCaptions, wordsText } from '../lib/captions.mjs';

test('Thai segmentation preserves punctuation',()=>{
  const words=thaiWords('กำลังทดสอบระบบใหม่ครับ!', 'th');
  assert.ok(words.length>=4); assert.match(words.at(-1).text,/!$/);
});
test('Whisper language names map to segmenter locales',()=>assert.ok(thaiWords('กำลังทดสอบ','thai').length>=2));
test('token timestamps aggregate into Thai words',()=>{
  const tokens=[{text:'กำ',start:0,end:.1,confidence:.9},{text:'ลัง',start:.1,end:.25,confidence:.8},{text:'ทด',start:.3,end:.4,confidence:.9},{text:'สอบ',start:.4,end:.6,confidence:.9}];
  const words=tokensToWords(tokens,'th'); assert.equal(words[0].text,'กำลัง'); assert.equal(words[0].start,0); assert.equal(words[0].end,.25);
});
test('zero-duration high-confidence words are retained and made sequential',()=>{
  const words=tokensToWords([{text:'เรา',start:8,end:8,confidence:.95},{text:'จะ',start:8,end:8,confidence:.98},{text:'ไป',start:8,end:8,confidence:.97}],'th');
  assert.deepEqual(words.map(x=>x.text),['เรา','จะ','ไป']);
  assert.ok(words.every(x=>x.end>x.start));
  assert.ok(words[1].start>=words[0].end);
});
test('English token spaces remain word boundaries',()=>{const words=tokensToWords([{text:' Hello',start:0,end:.2},{text:' this',start:.2,end:.4},{text:' is',start:.4,end:.5}], 'english');assert.deepEqual(words.map(x=>x.text),['Hello','this','is'])});
test('Thai ASR whitespace does not create artificial word spaces',()=>{
  const words=tokensToWords([{text:'อ้าว',start:0,end:.4},{text:' ',start:.4,end:.4},{text:'รถม้า',start:.5,end:1}], 'th');
  assert.equal(wordsText(words),'อ้าวรถม้า');
  assert.equal(words.find(x=>x.text==='รถ').phraseBreak,false);
});
test('groups stop at long pauses and punctuation',()=>{
  const words=[{text:'หนึ่ง',start:0,end:.2},{text:'สอง.',start:.2,end:.4},{text:'สาม',start:2,end:2.2}];
  assert.equal(groupWords(words,5).length,2);
});
test('groups split on a quarter-second silence',()=>{const words=[{text:'ก่อน',start:0,end:.3},{text:'หลัง',start:.6,end:.9}];assert.equal(groupWords(words,5).length,2)});
test('silence alignment removes overlap before caption grouping',()=>{
  const words=[
    {id:'a',text:'before',start:13.93,end:15.70},
    {id:'b',text:'after',start:15.76,end:16.35},
    {id:'c',text:'end',start:16.35,end:16.82},
    {id:'d',text:'hallucination',start:15.80,end:15.95},
  ];
  const aligned=snapWordsToSpeech(words,[{start:15.7413,end:16.0397}]);
  assert.equal(aligned.find(x=>x.id==='b').start,16.0397);
  assert.equal(aligned.some(x=>x.id==='d'),false);
  const captions=groupWords(aligned,5);
  assert.equal(captions.length,2);
  assert.equal(captions[0].end,15.70);
  assert.equal(captions[1].start,16.0397);
});
test('a word spanning a full silence keeps only its longer voiced side',()=>{
  const aligned=snapWordsToSpeech([{id:'a',text:'word',start:15.48,end:16.12}],[{start:15.7413,end:16.0397}]);
  assert.equal(aligned[0].start,15.48);
  assert.equal(aligned[0].end,15.7413);
});
test('long DTW words are capped without moving their speech onset',()=>{
  const [word]=capWordDurations([{id:'a',text:'บ้าน',start:20,end:21.5}]);
  assert.ok(word.end-word.start<=.501);
  assert.equal(word.start,20);assert.ok(word.end<21.5);
});
test('a long word reduced to a tiny voiced fragment is removed',()=>{
  const words=snapWordsToSpeech([{id:'a',text:'บ้าน',start:23,end:24.24}],[{start:23.056,end:24.3}]);
  assert.deepEqual(words,[]);
});
test('edited caption rebuilds consistent words',()=>{
  const caption=normalizeEditedCaption({id:'c',text:'แก้ข้อความใหม่',start:1,end:2},'th');
  assert.equal(caption.words[0].start,1);assert.equal(caption.words.at(-1).end,2);assert.equal(caption.text,wordsText(caption.words));
});
test('invalid caption time is rejected',()=>assert.throws(()=>validateCaptions([{start:2,end:1,text:'ผิด'}])));
