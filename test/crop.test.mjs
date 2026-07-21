import test from 'node:test';
import assert from 'node:assert/strict';
import { cropFilter, cropGeometry, normalizeCropStyle } from '../lib/crop.mjs';

test('crop style accepts known ratios and clamps focal position',()=>{
  const known=normalizeCropStyle({cropAspect:'9:16',cropX:120,cropY:-5}),invalid=normalizeCropStyle({cropAspect:'bad'});
  assert.deepEqual({cropAspect:known.cropAspect,cropX:known.cropX,cropY:known.cropY},{cropAspect:'9:16',cropX:100,cropY:0});
  assert.deepEqual({cropAspect:invalid.cropAspect,cropX:invalid.cropX,cropY:invalid.cropY},{cropAspect:'original',cropX:50,cropY:50});
});

test('landscape video crops to portrait around the selected horizontal position',()=>{
  const centered=cropGeometry(1920,1080,{cropAspect:'9:16',cropX:50}),right=cropGeometry(1920,1080,{cropAspect:'9:16',cropX:100});
  assert.deepEqual({width:centered.width,height:centered.height,x:centered.x,y:centered.y},{width:608,height:1080,x:656,y:0});
  assert.equal(right.x,1312);
  assert.equal(cropFilter(centered),'crop=608:1080:656:0,setsar=1');
});

test('portrait video crops vertically for square and leaves original untouched',()=>{
  const square=cropGeometry(720,1280,{cropAspect:'1:1',cropY:50}),original=cropGeometry(720,1280,{cropAspect:'original'});
  assert.deepEqual({width:square.width,height:square.height,x:square.x,y:square.y},{width:720,height:720,x:0,y:280});
  assert.equal(original.active,false);
  assert.equal(cropFilter(original),'');
});

test('free crop uses independent edges and prevents an empty frame',()=>{
  const geometry=cropGeometry(1280,720,{cropAspect:'free',cropLeft:10,cropRight:20,cropTop:5,cropBottom:15}),limited=normalizeCropStyle({cropAspect:'free',cropLeft:80,cropRight:80});
  assert.deepEqual({width:geometry.width,height:geometry.height,x:geometry.x,y:geometry.y},{width:896,height:576,x:128,y:36});
  assert.equal(cropFilter(geometry),'crop=896:576:128:36,setsar=1');
  assert.equal(Math.round(limited.cropLeft+limited.cropRight),90);
});

test('free crop top and bottom select opposite source regions',()=>{
  const fromTop=cropGeometry(720,1280,{cropAspect:'free',cropTop:20,cropBottom:0});
  const fromBottom=cropGeometry(720,1280,{cropAspect:'free',cropTop:0,cropBottom:20});
  assert.equal(fromTop.height,fromBottom.height);
  assert.equal(fromTop.y,256);
  assert.equal(fromBottom.y,0);
  assert.notEqual(cropFilter(fromTop),cropFilter(fromBottom));
});
