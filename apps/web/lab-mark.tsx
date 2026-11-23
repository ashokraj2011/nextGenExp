export function LabMark({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" className={"lab-mark" + (small ? " small" : "")}><i /><i /><i /><i /></span>;
}
