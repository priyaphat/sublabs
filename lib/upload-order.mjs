export function toggleUploadOrder(order,index){
  const current=Array.isArray(order)?order:[],position=current.indexOf(index);
  return position>=0?current.filter(value=>value!==index):[...current,index];
}

export function orderedUploadFiles(files,order){
  const source=Array.from(files||[]),sequence=Array.from(order||[]);
  if(sequence.length!==source.length||new Set(sequence).size!==source.length||sequence.some(index=>!Number.isInteger(index)||index<0||index>=source.length))throw new Error('กรุณาคลิกเลือกคลิปให้ครบตามลำดับ');
  return sequence.map(index=>source[index]);
}

export function reorderUploadedFilesByName(files,names,normalize=value=>String(value||'')){
  const source=Array.from(files||[]),sequence=Array.isArray(names)?names:[];
  if(sequence.length!==source.length)return source;
  const buckets=new Map();
  for(const file of source){const key=normalize(file.originalname);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(file)}
  const ordered=[];
  for(const name of sequence){const bucket=buckets.get(normalize(name));if(!bucket?.length)return source;ordered.push(bucket.shift())}
  return ordered.length===source.length?ordered:source;
}
