"""
消費税計算エンジン

主な処理:
  1. 課税売上割合の計算
  2. 仕入税額控除の計算（95%ルール・一括比例配分方式・個別対応方式）
  3. 納付消費税額の計算
"""

from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN
from typing import Sequence

from .models import (
    TaxCategory,
    TransactionType,
    PurchaseUsage,
    Transaction,
    NATIONAL_TAX_RATES,
)

# 課税売上高が5億円以下かつ課税売上割合95%以上なら全額控除
FULL_CREDIT_SALES_THRESHOLD = Decimal("500_000_000")
FULL_CREDIT_RATIO_THRESHOLD = Decimal("0.95")


@dataclass
class SalesSummary:
    """売上の集計結果"""
    taxable_standard: Decimal = Decimal("0")   # 課税売上（標準税率、税抜）
    taxable_reduced: Decimal = Decimal("0")    # 課税売上（軽減税率、税抜）
    export_exempt: Decimal = Decimal("0")      # 輸出免税売上（税抜）
    non_taxable: Decimal = Decimal("0")        # 非課税売上

    # 売上消費税額（国税分）
    output_tax_standard: Decimal = Decimal("0")
    output_tax_reduced: Decimal = Decimal("0")

    @property
    def taxable_sales_total(self) -> Decimal:
        """課税売上高合計（税抜）＝ 標準 ＋ 軽減 ＋ 輸出免税"""
        return self.taxable_standard + self.taxable_reduced + self.export_exempt

    @property
    def total_sales(self) -> Decimal:
        """売上高合計（課税売上 ＋ 非課税売上）"""
        return self.taxable_sales_total + self.non_taxable

    @property
    def output_tax_total(self) -> Decimal:
        return self.output_tax_standard + self.output_tax_reduced

    @property
    def taxable_sales_ratio(self) -> Decimal:
        """
        課税売上割合 = 課税売上高（税抜）/ 総売上高
        不課税取引は分母に含まない。
        """
        if self.total_sales == 0:
            return Decimal("0")
        ratio = self.taxable_sales_total / self.total_sales
        return ratio.quantize(Decimal("0.0001"), rounding=ROUND_DOWN)


@dataclass
class PurchaseSummary:
    """仕入・経費の集計結果（個別対応方式）"""
    taxable_for_taxable: Decimal = Decimal("0")      # 課税売上対応・仕入税額
    taxable_for_non_taxable: Decimal = Decimal("0")  # 非課税売上対応・仕入税額
    taxable_common: Decimal = Decimal("0")           # 共通対応・仕入税額


@dataclass
class TaxReturnSummary:
    """消費税申告書サマリー"""
    sales: SalesSummary
    taxable_sales_ratio: Decimal
    output_tax: Decimal            # 売上消費税額（国税分）
    input_tax_credit: Decimal      # 仕入税額控除額
    net_tax_payable: Decimal       # 差引税額（国税分）
    local_consumption_tax: Decimal # 地方消費税額
    total_tax_payable: Decimal     # 合計納付税額
    credit_method: str             # 控除方式の説明


class ConsumptionTaxCalculator:
    """
    消費税の計算クラス。

    インボイス制度（2023年10月1日〜）に対応。
    申告方式は「本則課税」を前提とする（簡易課税は対象外）。
    """

    def summarize_sales(self, transactions: Sequence[Transaction]) -> SalesSummary:
        summary = SalesSummary()
        for tx in transactions:
            if tx.transaction_type != TransactionType.SALES:
                continue
            national_rate = NATIONAL_TAX_RATES[tx.tax_category]
            national_tax = (tx.amount_excl_tax * national_rate).quantize(Decimal("1"))

            match tx.tax_category:
                case TaxCategory.STANDARD_RATE:
                    summary.taxable_standard += tx.amount_excl_tax
                    summary.output_tax_standard += national_tax
                case TaxCategory.REDUCED_RATE:
                    summary.taxable_reduced += tx.amount_excl_tax
                    summary.output_tax_reduced += national_tax
                case TaxCategory.EXPORT_EXEMPT:
                    summary.export_exempt += tx.amount_excl_tax
                case TaxCategory.NON_TAXABLE:
                    summary.non_taxable += tx.amount_excl_tax
                # OUT_OF_SCOPE は売上計算に含めない

        return summary

    def summarize_purchases_individual(
        self, transactions: Sequence[Transaction]
    ) -> PurchaseSummary:
        """個別対応方式による仕入税額の集計"""
        summary = PurchaseSummary()
        for tx in transactions:
            if tx.transaction_type != TransactionType.PURCHASE:
                continue
            creditable = tx.creditable_tax_amount
            if creditable == 0:
                continue
            match tx.purchase_usage:
                case PurchaseUsage.TAXABLE_ONLY:
                    summary.taxable_for_taxable += creditable
                case PurchaseUsage.NON_TAXABLE_ONLY:
                    summary.taxable_for_non_taxable += creditable
                case PurchaseUsage.COMMON:
                    summary.taxable_common += creditable
        return summary

    def calculate_input_credit_proportional(
        self,
        transactions: Sequence[Transaction],
        taxable_ratio: Decimal,
    ) -> Decimal:
        """一括比例配分方式：仕入税額合計 × 課税売上割合"""
        total_input = sum(
            tx.creditable_tax_amount
            for tx in transactions
            if tx.transaction_type == TransactionType.PURCHASE
        )
        return (Decimal(total_input) * taxable_ratio).quantize(Decimal("1"), rounding=ROUND_DOWN)

    def calculate_input_credit_individual(
        self,
        purchase_summary: PurchaseSummary,
        taxable_ratio: Decimal,
    ) -> Decimal:
        """
        個別対応方式：
          控除額 = 課税対応分 ＋ 共通対応分 × 課税売上割合
        """
        common_credit = (purchase_summary.taxable_common * taxable_ratio).quantize(
            Decimal("1"), rounding=ROUND_DOWN
        )
        return purchase_summary.taxable_for_taxable + common_credit

    def calculate(
        self,
        transactions: Sequence[Transaction],
        use_individual_method: bool = True,
    ) -> TaxReturnSummary:
        """
        消費税の申告額を計算する。

        Args:
            transactions: 対象期間のすべての取引
            use_individual_method: True=個別対応方式、False=一括比例配分方式
        """
        sales = self.summarize_sales(transactions)
        ratio = sales.taxable_sales_ratio
        output_tax = sales.output_tax_total

        # 全額控除の判定（95%ルール）
        total_input_tax = sum(
            tx.creditable_tax_amount
            for tx in transactions
            if tx.transaction_type == TransactionType.PURCHASE
        )
        total_input_tax = Decimal(total_input_tax)

        if (
            ratio >= FULL_CREDIT_RATIO_THRESHOLD
            and sales.taxable_sales_total <= FULL_CREDIT_SALES_THRESHOLD
        ):
            input_credit = total_input_tax
            credit_method = f"全額控除（課税売上割合 {ratio:.1%} ≥ 95%、課税売上 ≤ 5億円）"
        elif use_individual_method:
            purchase_summary = self.summarize_purchases_individual(transactions)
            input_credit = self.calculate_input_credit_individual(purchase_summary, ratio)
            credit_method = f"個別対応方式（課税売上割合 {ratio:.1%}）"
        else:
            input_credit = self.calculate_input_credit_proportional(transactions, ratio)
            credit_method = f"一括比例配分方式（課税売上割合 {ratio:.1%}）"

        # 差引税額（国税分、100円未満切捨て）
        net_national = max(output_tax - input_credit, Decimal("0"))
        net_national = (net_national // 100) * 100

        # 地方消費税 = 国税分 × 22/78
        local_tax = (net_national * Decimal("22") / Decimal("78")).quantize(
            Decimal("100"), rounding=ROUND_DOWN
        )

        return TaxReturnSummary(
            sales=sales,
            taxable_sales_ratio=ratio,
            output_tax=output_tax,
            input_tax_credit=input_credit,
            net_tax_payable=net_national,
            local_consumption_tax=local_tax,
            total_tax_payable=net_national + local_tax,
            credit_method=credit_method,
        )
