/**
 * Waiting-room admission check (UC3 → UC4). Per the proposal, the API checks the fan's admission token in
 * DynamoDB `live-queue` before letting them hold seats.
 *
 * TODO(Yan Ting / Shi Hui): every fan is treated as admitted for now. UC3's `live-queue` table exists on main
 * (key: eventId + userId, one row per fan per concert), but queue-manager only writes `status = 'WAITING'`
 * rows so far; the admit step and token format are still to come. Replace the body with that lookup once
 * they exist; callers don't need to change.
 */
export async function isAdmitted(_fanId: string, _concertId: string): Promise<boolean> {
  return true;
}
