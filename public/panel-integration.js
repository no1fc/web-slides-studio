(() => {
  const assets = el('button','자산 보관함'); assets.id='assetsBtn'; assets.type='button';
  $('ribbon-insert').append(assets);
  const quick = el('button'); quick.id='headerAssetsBtn'; quick.type='button'; quick.title='자산 보관함'; quick.setAttribute('aria-label','자산 보관함');
  quick.append(SDIcons.icon('image')); quick.className='shell-icon-button'; document.querySelector('.shell-header-left').append(quick);
  quick.onclick=()=>assets.click();
  const requireTarget=expected=>{
    if(deck?.id!==expected.deckId||state.order[index]!==expected.slideId||transitionBusy||blocked)throw new Error('편집 대상이 바뀌었습니다. 보관함을 다시 열어 주세요.');
  };
  SDAssets.init({api,getDeck:()=>deck,getState:()=>state,getSelected:()=>selected,getSlideId:()=>state.order[index],
    insertImage:async(src,expected)=>{await settleEditing();requireTarget(expected);await structural(()=>state.added.push({id:uid('a'),slide:expected.slideId,kind:'image',src,image:SDObjects.normalizeImage({mode:'fit'}),x:150,y:200,w:640,h:400}));},
    replaceImage:async(src,expected)=>{await settleEditing();requireTarget(expected);if(selected?.id!==expected.elementId||objectLocked(selected.id))throw new Error('선택한 이미지를 다시 확인해 주세요.');patch({src,...(nativeAdded(selected.id)?.kind==='image'?{image:SDObjects.normalizeImage({mode:selected.image?.mode||'fit'})}:{})});await flush();},
    onNavigate:async(slideId)=>{await settleEditing();await flush();const position=state.order.indexOf(slideId);if(position<0)throw new Error('슬라이드가 없습니다.');index=position;post('go',{index});renderSlides();renderLayers();}
  });
  const clear=el('button','배경 채우기 없음');clear.type='button';clear.id='clearObjectFillBtn';$('properties').append(clear);
  clear.onclick=action(()=>{if(!selected||objectLocked(selected.id))return;if(nativeAdded(selected.id)?.kind==='shape')patch({shape:SDObjects.normalizeShape({...selected.shape,fill:'none'})});else if(nativeAdded(selected.id)?.kind!=='group')patch({fill:'none'});});
})();
