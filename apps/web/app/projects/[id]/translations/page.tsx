import { TranslationEditor } from '@/components/translations/TranslationEditor';

export default async function TranslationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fileId?: string }>;
}) {
  const { id } = await params;
  const { fileId } = await searchParams;
  return <TranslationEditor projectId={id} xliffFileId={fileId} />;
}
