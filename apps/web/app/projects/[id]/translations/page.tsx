import { TranslationEditor } from '@/components/translations/TranslationEditor';

export default async function TranslationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fileId?: string; objectFilter?: string }>;
}) {
  const { id } = await params;
  const { fileId, objectFilter } = await searchParams;
  return <TranslationEditor projectId={id} xliffFileId={fileId} initialObjectFilter={objectFilter} />;
}
