import { FeaturePlaceholder } from '../../app/FeaturePlaceholder';

export function CheckoutPage() {
  return (
    <FeaturePlaceholder title="Checkout" useCase="UC4" owner="Shi Hui" endpoint="/api/checkout/holds">
      <p>Pick seats, hold them for 10 minutes, pay (simulated) and confirm the order.</p>
    </FeaturePlaceholder>
  );
}
