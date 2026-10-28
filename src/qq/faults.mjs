// Only fixed descriptions enter administrator logs. SDK errors can contain
// chat text, local paths or credentials, so never log their raw messages.
const known = new Map([
  ['Unsupported QQ message conversation type', 'message_conversation_unsupported'],
  ['QQ message identity has no message ID', 'message_id_missing'],
  ['QQ message identity has no peer', 'message_peer_missing'],
  ['QQ message identity has no resolved sender', 'message_sender_unresolved'],
  ['QQ message identity could not be resolved', 'message_identity_unresolved'],
  ['Invalid QQ message timestamp', 'message_timestamp_invalid'],
  ['Invalid QQ group identity', 'message_group_invalid'],
  ['QQ message has no supported content', 'message_content_unsupported'],
  ['QQ message normalization failed', 'message_normalization_failed'],
  ['Cannot save QQ validation record', 'kernel_validation_write_failed'],
  ['Official QQ kernel host fault', 'kernel_host_fault'],
  ['QQ kernel host did not exit after shutdown', 'kernel_shutdown_timeout'],
  ['OneBot message ID space exhausted', 'message_id_exhausted']
]);
const reasons = new Set([...known.values(), 'driver_operation_failed']);
export function describeDriverFault(error) {
  return {
    code: Number.isSafeInteger(error?.code) ? error.code : 1500,
    reason: reasons.has(error?.reason) ? error.reason : known.get(error?.message) || 'driver_operation_failed'
  };
}
