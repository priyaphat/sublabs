import test from 'node:test';
import assert from 'node:assert/strict';
import { captionVisualState,effectDefinition } from '../public/effects.js';

const caption={id:'c',start:0,end:2,text:'one two',words:[{text:'one',start:0,end:.6},{text:'two',start:1,end:1.6}]};
test('effect state machine keeps sentence animation at caption scope',()=>{const state=captionVisualState(caption,1.2,'sentence');assert.equal(state.animationIndex,0);assert.equal(state.definition.animate,'caption')});
test('progressive reveal keeps prior words and animates only the new word',()=>{const state=captionVisualState(caption,1.2,'progressive');assert.equal(state.visibleEnd,1);assert.equal(state.animationIndex,1);assert.equal(effectDefinition('karaoke').animate,'highlight-only')});
test('current word is hidden inside an actual speech gap',()=>assert.equal(captionVisualState(caption,.8,'word'),null));
