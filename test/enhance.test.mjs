import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancementFilters, fullHdGeometry } from '../lib/enhance.mjs';

test('full HD geometry preserves common landscape and portrait ratios',()=>{
  assert.deepEqual(fullHdGeometry(1280,720),{width:1920,height:1080});
  assert.deepEqual(fullHdGeometry(720,1280),{width:1080,height:1920});
  assert.deepEqual(fullHdGeometry(640,480),{width:1440,height:1080});
});

test('enhancement filter is opt-in and includes denoise upscale and sharpen',()=>{
  assert.deepEqual(enhancementFilters(1280,720,false),[]);
  const filters=enhancementFilters(1280,720,true);
  assert.match(filters.join(','),/hqdn3d/);
  assert.match(filters.join(','),/scale=1920:1080:flags=lanczos/);
  assert.match(filters.join(','),/unsharp/);
});
