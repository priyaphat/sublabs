export const EFFECTS={
  sentence:{show:'caption',animate:'caption'},
  word:{show:'active-word',animate:'active-word'},
  progressive:{show:'revealed-words',animate:'new-word'},
  karaoke:{show:'caption',animate:'highlight-only'},
};

export function effectDefinition(effect){return EFFECTS[effect]||EFFECTS.sentence}

export function captionVisualState(caption,time,effect='sentence'){
  if(!caption||time<caption.start||time>=caption.end)return null;
  const words=caption.words||[],activeIndex=words.findIndex(word=>time>=word.start&&time<word.end),previousIndex=words.findLastIndex(word=>word.end<=time),definition=effectDefinition(effect);
  if(definition.show==='active-word'&&activeIndex<0)return null;
  const visibleEnd=definition.show==='revealed-words'?(activeIndex>=0?activeIndex:previousIndex):words.length-1;
  if(definition.show==='revealed-words'&&visibleEnd<0)return null;
  return{caption,words,activeIndex,visibleEnd,definition,stateIndex:effect==='sentence'?0:effect==='progressive'?visibleEnd:activeIndex,animationIndex:definition.animate==='caption'?0:definition.animate==='highlight-only'?-1:(effect==='progressive'?visibleEnd:activeIndex)};
}
