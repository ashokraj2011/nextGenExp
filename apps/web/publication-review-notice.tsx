import { useEffect, useState } from "react";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import { approvalChatHref } from "../../packages/contracts/admin-paths";
import { publicationReviewEvent } from "./api";
import "./publication-review.css";

export function PublicationReviewNotice() {
  const [approval, setApproval] = useState<ApprovalRecord>();

  useEffect(() => {
    const receive = (event: Event) => setApproval((event as CustomEvent<ApprovalRecord>).detail);
    window.addEventListener(publicationReviewEvent, receive);
    return () => window.removeEventListener(publicationReviewEvent, receive);
  }, []);

  if (!approval) return null;
  return <section className="publication-review-notice" role="status" aria-label="Publication review requested">
    <strong>Approval requested</strong>
    <p>{approval.title}</p>
    <div className="publication-review-links">
      <a href={approvalChatHref(approval.id)} target="_blank" rel="noreferrer">Review in Admin chat</a>
      <button type="button" className="secondary-button" onClick={() => setApproval(undefined)}>Dismiss</button>
    </div>
  </section>;
}
