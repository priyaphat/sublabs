import test from 'node:test';
import assert from 'node:assert/strict';
import {characterErrorRate,evaluateFixture,wordErrorRate,wordsOutsideSpeech} from '../lib/quality.mjs';

test('quality metrics report recognition and silence errors',()=>{assert.equal(wordErrorRate('hello world','hello word','en'),.5);assert.ok(characterErrorRate('abcd','abxd')>.2);assert.equal(wordsOutsideSpeech([{text:'x',start:2,end:3}],[{start:0,end:1}]).length,1)});
test('fixture evaluation includes word timing median',()=>{const metrics=evaluateFixture({language:'en',reference:{text:'one two',words:[{text:'one',start:0,end:.5}]},baseline:{text:'one wrong'},candidate:{text:'one two',words:[{text:'one',start:.1,end:.6}]},speechRegions:[{start:0,end:1}]});assert.equal(metrics.candidateWer,0);assert.ok(Math.abs(metrics.medianBoundaryError-.1)<1e-9)});
