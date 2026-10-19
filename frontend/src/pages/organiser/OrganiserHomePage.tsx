import { FeaturePlaceholder } from '../../app/FeaturePlaceholder';

export function OrganiserHomePage() {
  return (
    <FeaturePlaceholder title="My concerts" useCase="UC5" owner="Elroy" endpoint="/api/organiser/concerts">
      <p>Create and manage concerts, ticket types and seat layouts, and watch the live sales dashboard.</p>
    </FeaturePlaceholder>
  );
}
