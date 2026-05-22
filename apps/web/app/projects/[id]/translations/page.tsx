import { TranslationEditor } from '@/components/translations/TranslationEditor';

export default async function TranslationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fileId?: string; objectFilter?: string; filter?: string }>;
}) {
  const { id } = await params;
  const { fileId, objectFilter, filter } = await searchParams;
  return <TranslationEditor projectId={id} xliffFileId={fileId} initialObjectFilter={objectFilter} initialFilter={filter} />;
}
