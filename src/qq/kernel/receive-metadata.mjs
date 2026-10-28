// Bounded structural diagnostics only: never include IDs, text, URLs or paths.
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
export function receiveMetadata(raw) {
  const elements = Array.isArray(raw?.elements) ? raw.elements.slice(0, 32) : [];
  const uid = raw?.senderUid;
  const uin = raw?.senderUin;
  const uinNumber = typeof uin === 'string' || typeof uin === 'number' ? Number(uin) : NaN;
  return {
    chat_type: integer(raw?.chatType), msg_type: integer(raw?.msgType),
    sub_msg_type: integer(raw?.subMsgType), send_type: integer(raw?.sendType),
    sender_uid_kind: !uid ? 'missing' : uid === '0' ? 'zero' : typeof uid === 'string' && /^u_[\w-]+$/.test(uid) ? 'uid' : 'invalid',
    sender_uin_kind: uin === undefined || uin === null || uin === '' ? 'missing' : uinNumber === 0 ? 'zero' :
      Number.isSafeInteger(uinNumber) && uinNumber > 0 ? 'uin' : 'invalid',
    element_types: elements.map(element => integer(element?.elementType)),
    gray_tip_types: elements.filter(element => Number(element?.elementType) === 8).map(element => integer(element?.grayTipElement?.subElementType)),
    gray_tip_groups: elements.filter(element => Number(element?.elementType) === 8).map(element => integer(element?.grayTipElement?.groupElement?.type))
  };
}
