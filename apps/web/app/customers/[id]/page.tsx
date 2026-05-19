import { CustomerDetail } from '@/components/customers/CustomerDetail';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail customerId={id} />;
}
