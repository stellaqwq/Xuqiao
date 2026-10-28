import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveMetadata } from '../src/qq/kernel/receive-metadata.mjs';

test('receive metadata reports only bounded structural fields', () => {
  const secret = 'private message Cookie credential path';
  const result = receiveMetadata({chatType:2,msgType:5,subMsgType:8,sendType:3,
    senderUid:'',senderUin:'0',peerUid:secret,msgId:secret,sendNickName:secret,
    elements:[{elementType:8,grayTipElement:{subElementType:4,groupElement:{type:1,memberUid:secret,groupName:secret}}}]});
  assert.deepEqual(result,{chat_type:2,msg_type:5,sub_msg_type:8,send_type:3,sender_uid_kind:'missing',sender_uin_kind:'zero',
    element_types:[8],gray_tip_types:[4],gray_tip_groups:[1]});
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(receiveMetadata({elements:Array.from({length:1000},()=>({elementType:1}))}).element_types.length,32);
  assert.equal(receiveMetadata({chatType:secret}).chat_type,null);
});
