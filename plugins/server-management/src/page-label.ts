export interface PageLabel {
  (): string
  group?: string
  groupLabel?: string
  icon?: string
}

/** Group fields ride on the label. The slot ledger keeps `label` and drops other register fields. */
export function pageLabel(text: () => string, place: { group: string; groupLabel: string; icon?: string }): PageLabel {
  const label: PageLabel = () => text()
  label.group = place.group
  label.groupLabel = place.groupLabel
  if (place.icon !== undefined && place.icon !== '') label.icon = place.icon
  return label
}
