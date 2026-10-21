import { Link, useParams } from 'react-router-dom';
import { FeaturePlaceholder } from '../../app/FeaturePlaceholder';

export function ConcertDetailPage() {
  const { concertId = '' } = useParams();
  return (
    <FeaturePlaceholder
      title="Concert detail"
      useCase="UC1"
      owner="Cody & Nai Xin"
      endpoint={`/api/concerts/${encodeURIComponent(concertId)}`}
    >
      <p>Artist, date, venue, ticket types, prices and the live seat map.</p>
      <div className="row">
        <Link to={`/concerts/${concertId}/waiting-room`} className="btn">
          Get a ticket
        </Link>
        <Link to={`/concerts/${concertId}/checkout`} className="btn ghost">
          Go to checkout
        </Link>
      </div>
    </FeaturePlaceholder>
  );
}
