import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSpeechRegions,parseVadSpeechRegions} from '../lib/whisper.mjs';

test('VAD speech segments become padded merged regions',()=>{const regions=extractSpeechRegions({segments:[{start:1,end:2,no_speech_prob:.1},{start:2.02,end:3,no_speech_prob:.1},{start:5,end:6,no_speech_prob:.9,avg_logprob:-1}]});assert.equal(regions.length,1);assert.equal(regions[0].start,.92);assert.equal(regions[0].end,3.08)});
test('standalone Silero VAD output maps centiseconds to source seconds',()=>{const regions=parseVadSpeechRegions('Speech segment 0: start = 146.00, end = 360.00\nSpeech segment 1: start = 3250.00, end = 3301.00');assert.deepEqual(regions.map(x=>[x.start,x.end]),[[1.46,3.6],[32.5,33.01]])});
