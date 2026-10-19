import { useParams } from 'react-router-dom';
import { FeaturePlaceholder } from '../../app/FeaturePlaceholder';

export function WaitingRoomPage() {
  const { concertId = '' } = useParams();
  return (
    <FeaturePlaceholder
      title="Waiting room"
      useCase="UC3"
      owner="Yan Ting"
      endpoint={`/api/waiting-room/${encodeURIComponent(concertId)}/status`}
    >
      <p>Join the queue, see your live queue number, and move on to checkout once admitted.</p>
    </FeaturePlaceholder>
  );
}
