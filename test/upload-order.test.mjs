import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderedUploadFiles,
  reorderUploadedFilesByName,
  toggleUploadOrder,
} from '../lib/upload-order.mjs';

test('records files in the order their names are clicked', () => {
  let order=[];
  order=toggleUploadOrder(order,2);
  order=toggleUploadOrder(order,0);
  order=toggleUploadOrder(order,1);

  assert.deepEqual(order,[2,0,1]);
  assert.deepEqual(
    orderedUploadFiles([{name:'a.mp4'},{name:'b.mp4'},{name:'c.mp4'}],order).map(file=>file.name),
    ['c.mp4','a.mp4','b.mp4'],
  );
});

test('clicking an already ordered file removes it and compacts the order', () => {
  assert.deepEqual(toggleUploadOrder([2,0,1],0),[2,1]);
});

test('requires every selected file exactly once before upload', () => {
  const files=[{name:'a.mp4'},{name:'b.mp4'}];
  assert.throws(()=>orderedUploadFiles(files,[1]),/คลิกเลือกคลิปให้ครบ/);
  assert.throws(()=>orderedUploadFiles(files,[1,1]),/คลิกเลือกคลิปให้ครบ/);
});

test('server restores the submitted order, including duplicate names', () => {
  const files=[
    {id:1,originalname:'ตอนแรก.mp4'},
    {id:2,originalname:'ตอนแรก.mp4'},
    {id:3,originalname:'ตอนจบ.mp4'},
  ];
  const ordered=reorderUploadedFilesByName(
    files,
    ['ตอนจบ.mp4','ตอนแรก.mp4','ตอนแรก.mp4'],
  );

  assert.deepEqual(ordered.map(file=>file.id),[3,1,2]);
});

test('server keeps multipart order when order metadata is invalid', () => {
  const files=[{id:1,originalname:'a.mp4'},{id:2,originalname:'b.mp4'}];
  assert.deepEqual(reorderUploadedFilesByName(files,['missing.mp4']),files);
  assert.deepEqual(reorderUploadedFilesByName(files,['a.mp4','missing.mp4']),files);
});
