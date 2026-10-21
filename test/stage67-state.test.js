import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDeck, initialState, validateState, renderDeck } from '../src/deck.js';

const deck = prepareDeck('<html><body><main><section class="slide"><h1>Title</h1></section></main></body></html>');
const sample = () => ({ ...initialState(deck), added: [{id:'a-table',slide:'s0',kind:'table',x:100,y:200,w:800,h:300,table:{rows:[['항목','값'],['하나','42']]}}], transitions:{s0:'fade'}, animations:{'a-table':'appear'} });
test('table data and effects normalize, render safely and preserve old states', () => {
  const state = validateState(sample(), deck);
  assert.equal(state.added[0].table.rows[1][1], '42');
  assert.deepEqual(state.transitions, {s0:'fade'});
  assert.deepEqual(state.animations, {'a-table':'appear'});
  assert.match(renderDeck(deck.html, state), /<table/);
  const legacy = initialState(deck); delete legacy.transitions; delete legacy.animations;
  assert.deepEqual(validateState(legacy,deck).animations, {});
});
test('data object properties and effects reject wrong targets and unsupported transforms', () => {
  for (const mutate of [s=>s.transitions.s0='morph',s=>s.transitions.nope='fade',s=>s.animations.e0='fade',s=>s.animations['a-table']='spin',s=>s.added[0].rotate=20,s=>s.patches['a-table']={rotate:20},s=>s.patches.e0={table:{rows:[['x']]}},s=>s.added[0].text='replacement',s=>s.added[0].table.rows.push(['wrong'])]) {
    const state=sample(); mutate(state); assert.throws(()=>validateState(state,deck));
  }
});
test('previous stage maximum state remains editable after adding default effect fields', () => {
  const state=initialState(deck);delete state.transitions;delete state.animations;
  state.masters=Object.fromEntries(Array.from({length:21},(_,i)=>['m-pad-'+i,{name:'pad',html:'',css:'/**/'}]));
  let remaining=2001024-JSON.stringify(state).length;
  for(const master of Object.values(state.masters)){const n=Math.min(remaining,99996);master.css='/*'+'x'.repeat(n)+'*/';remaining-=n;}
  assert.equal(JSON.stringify(state).length,2001024);assert.doesNotThrow(()=>validateState(state,deck));
});
