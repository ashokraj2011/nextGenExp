import { ChartPie, GraduationCap, Scale } from "lucide-react";

export const planningTopics = [
  {
    id: "portfolio",
    name: "Portfolio",
    title: "Review your portfolio",
    description: "See your cash, holdings, and allocation.",
    prompt: "Let me know my portfolio summary.",
    Icon: ChartPie,
  },
  {
    id: "retirement",
    name: "Retirement",
    title: "Learn about retirement",
    description: "Explore the basics of planning for retirement.",
    prompt: "I'd like to learn about retirement.",
    Icon: GraduationCap,
  },
  {
    id: "retirement-accounts", name: "Retirement accounts", title: "Review your retirement accounts",
    description: "See your accounts and check who is named as a beneficiary.", prompt: "Show my retirement accounts.", Icon: GraduationCap,
  },
  {
    id: "balances",
    name: "Balances",
    title: "Understand your balances",
    description: "Compare available and current balance.",
    prompt: "Compare available and current balance.",
    Icon: Scale,
  },
] as const;
